import type { AppConfig } from "./config";
import type { BybitClient, OpenPositionSummary } from "./bybit/client";
import type { BreakevenLogger } from "./logging/breakevenLogger";
import { SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
import { replacePositionStop, stopLossOnValidSide } from "./decision/riskOrders";
import { roundToTick } from "./util/rounding";
import type { SymbolQueue } from "./util/symbolQueue";

const LOG_TAG = "[breakeven]";

/**
 * Периодически проверяет все открытые позиции и переносит стоп-лосс в безубыток+ (с учётом
 * комиссии за вход и выход — closing по стопу не должен уводить сделку в минус — плюс
 * небольшой гарантированный доход trading.breakevenExtraProfitPercent сверху, чтобы закрытие
 * по этому стопу не давало нулевой/минусовой результат даже с учётом реальных условий
 * исполнения), как только позиция ушла в плюс минимум на trading.breakevenTriggerPercent от
 * цены входа.
 *
 * Стоп ставится лимитным ордером (дешевле по комиссии), плюс независимый резервный market-SL
 * чуть дальше — на случай, если лимитник не успеет исполниться при резком движении (тот же
 * приём, что и для основного SL в executor.ts, см. SL_BACKUP_BUFFER_MULTIPLIER).
 *
 * Работает как таймер, а не постоянный цикл: start() запускается один раз после каждого
 * успешного открытия позиции (см. executor.ts) и на старте процесса (см. server.ts). Первая
 * проверка происходит не сразу, а через breakevenCheckIntervalSec после открытия — чтобы
 * резкий, но кратковременный всплеск волатильности сразу после входа (например, в момент
 * ликвидации на рынке) не переносил стоп в безубыток раньше времени и не выбивал позицию
 * на развороте. Если к моменту первого тика открытых позиций уже нет, тик сам себя
 * останавливает (clearInterval), и монитор не дёргает биржу до следующего открытия позиции.
 *
 * Работает независимо от TrailingStopMonitor (свой enable/trigger/interval в настройках), но
 * читает/пишет те же условные ордера позиции — оба монитора и executor.ts сериализуют доступ
 * к позиции по символу через общий SymbolQueue, чтобы не перезаписать более выгодный стоп менее
 * выгодным из-за гонки между таймерами.
 */
export class BreakevenMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Защита от наложения тиков, если один цикл проверки (несколько позиций, несколько
  // запросов к бирже на каждую) не успел завершиться до следующего запланированного тика.
  private ticking = false;

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly logger: BreakevenLogger,
    private readonly symbolQueue: SymbolQueue
  ) {}

  /** Идемпотентно: повторный вызов при уже запущенном таймере ничего не делает. */
  start(): void {
    if (!this.config.trading.breakevenEnabled) return;
    if (this.timer) return;

    const intervalMs = this.config.trading.breakevenCheckIntervalSec * 1000;
    console.log(`${LOG_TAG} monitor started (interval ${this.config.trading.breakevenCheckIntervalSec}s)`);
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log(`${LOG_TAG} no open positions, monitor stopped until next entry`);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const positions = await this.client.getOpenPositions();
      if (positions.length === 0) {
        this.stop();
        return;
      }
      for (const position of positions) {
        try {
          await this.symbolQueue.run(position.symbol, () => this.checkPosition(position));
        } catch (err) {
          console.error(`${LOG_TAG} check failed for ${position.symbol}:`, err);
        }
      }
    } catch (err) {
      console.error(`${LOG_TAG} failed to fetch open positions:`, err);
    } finally {
      this.ticking = false;
    }
  }

  private async checkPosition(position: OpenPositionSummary): Promise<void> {
    const { symbol, side, avgPrice, markPrice, size } = position;
    const sign = side === "Buy" ? 1 : -1;
    const profitPercent = (((markPrice - avgPrice) / avgPrice) * 100) * sign;
    if (profitPercent < this.config.trading.breakevenTriggerPercent) return;

    const [instrument, feeRate, stopOrders, lastPrice] = await Promise.all([
      this.client.getInstrumentInfo(symbol),
      this.client.getFeeRate(symbol),
      this.client.getOpenStopOrders(symbol),
      this.client.getLastPrice(symbol),
    ]);

    // Безубыток с учётом комиссии: цена, при закрытии по которой (по тейкеру, худший случай)
    // суммарные издержки на вход и выход не уводят сделку в минус. Плюс небольшой
    // гарантированный доход сверху (breakevenExtraProfitPercent) — иначе даже с этим стопом
    // сделка на практике часто закрывается в небольшой минус (проскальзывание, реальная
    // комиссия стопа), а не ровно в ноль.
    const roundTripFeeRate = feeRate.takerFeeRate * 2;
    const extraProfitRate = this.config.trading.breakevenExtraProfitPercent / 100;
    const breakevenDistanceRate = roundTripFeeRate + extraProfitRate;
    const breakevenPrice = roundToTick(avgPrice * (1 + sign * breakevenDistanceRate), instrument.tickSize);

    // Бот ставит SL через setTradingStop в tpslMode "Partial" — под этим режимом Bybit НЕ
    // отражает SL позиции в поле stopLoss самого объекта позиции (getPositionInfo), он
    // существует только как независимый резидентный ордер (stopOrderType "PartialStopLoss").
    // Поэтому сверяемся с этим ордером напрямую, а не с position.stopLoss — иначе бот не видит
    // свой же ранее выставленный стоп и пересоздаёт его на каждом тике. TP живёт отдельным
    // reduce-only лимитником (не condition-ордер) — этот монитор его не касается.
    const existingSl = stopOrders.find((o) => o.stopOrderType === "PartialStopLoss");

    // Расчётная цена не прошла валидацию (0/NaN — например из-за кривого tickSize): не трогаем
    // условные ордера позиции (иначе можно снять уже стоящий стоп и не поставить новый) и явно
    // логируем. return ДО try с отменой ордеров — существующий SL остаётся на месте.
    if (!Number.isFinite(breakevenPrice) || breakevenPrice <= 0) {
      this.logger.log({
        symbol,
        side,
        avgPrice,
        markPrice,
        profitPercent,
        previousStopLoss: existingSl ? existingSl.triggerPrice : null,
        newStopLoss: breakevenPrice,
        slOrderType: null,
        backupStopLoss: null,
        status: "failed",
        error: `расчётная цена безубытка некорректна (${breakevenPrice}), tickSize ${instrument.tickSize} — SL не двигаем`,
      });
      console.error(`${LOG_TAG} ${symbol} некорректная цена безубытка ${breakevenPrice}, пропускаем`);
      return;
    }

    // Стоп уже на безубытке или лучше — не отодвигаем его назад и не дёргаем биржу зря на
    // каждом тике.
    const alreadyProtected =
      existingSl !== undefined &&
      (side === "Buy" ? existingSl.triggerPrice >= breakevenPrice : existingSl.triggerPrice <= breakevenPrice);
    if (alreadyProtected) return;

    // Цена безубытка не с той стороны текущей цены (быстрый рынок ушёл дальше, чем markPrice
    // из snapshot позиции) — Bybit отбил бы setTradingStop (retCode 10001). Не трогаем
    // существующий стоп, ждём следующего тика.
    if (!stopLossOnValidSide(side, breakevenPrice, lastPrice)) {
      console.warn(
        `${LOG_TAG} ${symbol} цена безубытка ${breakevenPrice} не с той стороны цены ${lastPrice}, пропускаем тик`
      );
      return;
    }

    // Резервный market-SL чуть дальше лимитного безубытка — на случай, если лимитный ордер
    // не успеет исполниться при резком движении (тот же приём, что и для основного SL, см.
    // executor.ts). Дистанция от avgPrice до backup — дистанция до breakeven, увеличенная на
    // тот же множитель.
    const backupDistanceRate = breakevenDistanceRate * SL_BACKUP_BUFFER_MULTIPLIER;
    const backupPrice = roundToTick(avgPrice * (1 + sign * backupDistanceRate), instrument.tickSize);

    try {
      // place-before-cancel: новый SL ставим ДО отмены старого; старые ордера
      // риск-менеджмента снимаются внутри только после того, как новый SL подтверждён (см.
      // replacePositionStop — инцидент BNCUSDT 2026-09-08).
      const {
        appliedSlOrderType,
        limitFallbackReason,
        backupPlaced,
        backupError,
        cleanupError,
      } = await replacePositionStop(this.client, {
        symbol,
        positionSide: side,
        size,
        stopLoss: breakevenPrice,
        stopLossOrderType: "Limit",
        backupStopLoss: backupPrice,
        staleOrders: stopOrders,
      });

      const notes = [
        limitFallbackReason ? `limit SL rejected, fell back to market SL: ${limitFallbackReason}` : null,
        backupError ? `backup market SL not set: ${backupError}` : null,
        cleanupError ? `stale order cleanup failed: ${cleanupError}` : null,
      ].filter((note): note is string => note !== null);

      this.logger.log({
        symbol,
        side,
        avgPrice,
        markPrice,
        profitPercent,
        previousStopLoss: existingSl ? existingSl.triggerPrice : null,
        newStopLoss: breakevenPrice,
        slOrderType: appliedSlOrderType,
        backupStopLoss: backupPlaced ? backupPrice : null,
        status: "applied",
        error: notes.length > 0 ? notes.join("; ") : null,
      });
      console.log(
        `${LOG_TAG} ${symbol} SL moved to breakeven ${breakevenPrice} (${appliedSlOrderType}, profit ${profitPercent.toFixed(2)}%)`
      );
    } catch (err) {
      // Новый SL не удалось поставить — replacePositionStop в этом случае НЕ трогает старые
      // ордера, позиция остаётся под защитой прежнего стопа.
      const error = `${err instanceof Error ? err.message : String(err)} — прежний SL сохранён`;
      this.logger.log({
        symbol,
        side,
        avgPrice,
        markPrice,
        profitPercent,
        previousStopLoss: existingSl ? existingSl.triggerPrice : null,
        newStopLoss: breakevenPrice,
        slOrderType: null,
        backupStopLoss: null,
        status: "failed",
        error,
      });
      console.error(`${LOG_TAG} ${symbol} failed to move SL to breakeven (прежний SL сохранён):`, err);
    }
  }
}
