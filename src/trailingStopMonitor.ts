import type { AppConfig } from "./config";
import type { BybitClient, OpenPositionSummary } from "./bybit/client";
import type { TrailingLogger } from "./logging/trailingLogger";
import { SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
import { replacePositionStop, stopLossOnValidSide } from "./decision/riskOrders";
import { roundToTick } from "./util/rounding";
import type { SymbolQueue } from "./util/symbolQueue";

const LOG_TAG = "[trailing]";

/**
 * Периодически проверяет все открытые позиции и, как только позиция ушла в плюс минимум на
 * trading.trailingTriggerPercent от цены входа, подтягивает стоп-лосс вслед за ценой — на
 * trading.trailingStopPercent хуже ТЕКУЩЕЙ цены (не от входа, как в breakeven, а от markPrice —
 * классический trailing-stop). Стоп двигается только вперёд, в сторону прибыли: если цена
 * откатывается против позиции, новый кандидат оказывается хуже уже выставленного стопа и монитор
 * его не трогает — стоп остаётся на лучшей достигнутой точке.
 *
 * Стоп ставится лимитным ордером (дешевле по комиссии), плюс независимый резервный market-SL
 * чуть дальше — на случай, если лимитник не успеет исполниться при резком движении (тот же
 * приём, что и для breakeven/основного SL, см. SL_BACKUP_BUFFER_MULTIPLIER).
 *
 * Работает независимо от BreakevenMonitor (свой enable/trigger/interval в настройках), но
 * читает/пишет те же условные ордера позиции — оба монитора и executor.ts сериализуют доступ
 * к позиции по символу через общий SymbolQueue, чтобы не перезаписать более выгодный стоп менее
 * выгодным из-за гонки между таймерами.
 *
 * Работает как таймер, а не постоянный цикл: start() запускается один раз после каждого
 * успешного открытия позиции (см. executor.ts) и на старте процесса (см. server.ts). Первая
 * проверка происходит не сразу, а через trailingCheckIntervalSec после открытия — чтобы
 * резкий, но кратковременный всплеск волатильности сразу после входа (тот же каскад
 * ликвидаций, что и породил сигнал) не дёргал стоп по неактуальной цене в первые же
 * миллисекунды позиции (см. инцидент BNCUSDT 2026-09-08). Если к моменту первого тика
 * открытых позиций уже нет, тик сам себя останавливает (clearInterval).
 */
export class TrailingStopMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly logger: TrailingLogger,
    private readonly symbolQueue: SymbolQueue
  ) {}

  /** Идемпотентно: повторный вызов при уже запущенном таймере ничего не делает. */
  start(): void {
    if (!this.config.trading.trailingEnabled) return;
    if (this.timer) return;

    const intervalMs = this.config.trading.trailingCheckIntervalSec * 1000;
    console.log(`${LOG_TAG} monitor started (interval ${this.config.trading.trailingCheckIntervalSec}s)`);
    // Первый тик — не сразу, а через интервал: не трогаем стоп во всплеск волатильности
    // сразу после входа (см. комментарий к классу).
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
    if (profitPercent < this.config.trading.trailingTriggerPercent) return;

    const [instrument, stopOrders, lastPrice] = await Promise.all([
      this.client.getInstrumentInfo(symbol),
      this.client.getOpenStopOrders(symbol),
      this.client.getLastPrice(symbol),
    ]);

    const trailingDistance = this.config.trading.trailingStopPercent / 100;
    // Кандидат — на trailingStopPercent хуже ТЕКУЩЕЙ цены (не от входа), как и должен себя
    // вести trailing-stop.
    const candidatePrice = roundToTick(markPrice * (1 - sign * trailingDistance), instrument.tickSize);

    // См. комментарий в breakevenMonitor.ts про tpslMode "Partial": SL позиции виден только
    // как независимый резидентный ордер (stopOrderType "PartialStopLoss"), а не в поле
    // position.stopLoss. TP живёт отдельным reduce-only лимитником — этот монитор его не трогает.
    const existingSl = stopOrders.find((o) => o.stopOrderType === "PartialStopLoss");

    // Расчётная цена не прошла валидацию (0/NaN — например из-за кривого tickSize): не трогаем
    // условные ордера позиции (иначе можно снять уже стоящий стоп и не поставить новый) и явно
    // логируем. return ДО try с отменой ордеров — существующий SL остаётся на месте.
    if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) {
      this.logger.log({
        symbol,
        side,
        avgPrice,
        markPrice,
        profitPercent,
        previousStopLoss: existingSl ? existingSl.triggerPrice : null,
        newStopLoss: candidatePrice,
        slOrderType: null,
        backupStopLoss: null,
        status: "failed",
        error: `расчётная цена трейлинг-стопа некорректна (${candidatePrice}), tickSize ${instrument.tickSize} — SL не двигаем`,
      });
      console.error(`${LOG_TAG} ${symbol} некорректная цена трейлинг-стопа ${candidatePrice}, пропускаем`);
      return;
    }

    // Подтягиваем стоп только в сторону прибыли — если цена откатилась против позиции,
    // кандидат хуже уже выставленного стопа, и мы его не трогаем.
    const isImprovement =
      existingSl === undefined ||
      (side === "Buy" ? candidatePrice > existingSl.triggerPrice : candidatePrice < existingSl.triggerPrice);
    if (!isImprovement) return;

    // Кандидат посчитан от markPrice из snapshot позиции — на резко пилящем рынке он легко
    // оказывается уже не с той стороны текущей цены, и Bybit отбил бы setTradingStop (retCode
    // 10001). Не трогаем существующий стоп, ждём следующего тика с актуальной ценой.
    if (!stopLossOnValidSide(side, candidatePrice, lastPrice)) {
      console.warn(
        `${LOG_TAG} ${symbol} кандидат трейлинг-стопа ${candidatePrice} не с той стороны цены ${lastPrice}, пропускаем тик`
      );
      return;
    }

    const backupPrice = roundToTick(
      markPrice * (1 - sign * trailingDistance * SL_BACKUP_BUFFER_MULTIPLIER),
      instrument.tickSize
    );

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
        stopLoss: candidatePrice,
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
        newStopLoss: candidatePrice,
        slOrderType: appliedSlOrderType,
        backupStopLoss: backupPlaced ? backupPrice : null,
        status: "applied",
        error: notes.length > 0 ? notes.join("; ") : null,
      });
      console.log(
        `${LOG_TAG} ${symbol} SL trailed to ${candidatePrice} (${appliedSlOrderType}, profit ${profitPercent.toFixed(2)}%)`
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
        newStopLoss: candidatePrice,
        slOrderType: null,
        backupStopLoss: null,
        status: "failed",
        error,
      });
      console.error(`${LOG_TAG} ${symbol} failed to trail SL (прежний SL сохранён):`, err);
    }
  }
}
