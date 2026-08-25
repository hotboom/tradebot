import type { AppConfig } from "./config";
import type { BybitClient, OpenPositionSummary } from "./bybit/client";
import type { BreakevenLogger } from "./logging/breakevenLogger";
import type { OrderSide } from "./types";
import { SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
import { roundToTick } from "./util/rounding";

const LOG_TAG = "[breakeven]";

/**
 * Периодически проверяет все открытые позиции и переносит стоп-лосс в безубыток (с учётом
 * комиссии за вход и выход — closing по стопу не должен уводить сделку в минус), как только
 * позиция ушла в плюс минимум на trading.breakevenTriggerPercent от цены входа.
 *
 * Стоп ставится лимитным ордером (дешевле по комиссии), плюс независимый резервный market-SL
 * чуть дальше — на случай, если лимитник не успеет исполниться при резком движении (тот же
 * приём, что и для основного SL в executor.ts, см. SL_BACKUP_BUFFER_MULTIPLIER).
 *
 * Работает как таймер, а не постоянный цикл: start() запускается один раз после каждого
 * успешного открытия позиции (см. executor.ts) и на старте процесса (см. server.ts) — если
 * открытых позиций нет, первый же тик сам себя останавливает (clearInterval), и монитор не
 * дёргает биржу до следующего открытия позиции.
 */
export class BreakevenMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Защита от наложения тиков, если один цикл проверки (несколько позиций, несколько
  // запросов к бирже на каждую) не успел завершиться до следующего запланированного тика.
  private ticking = false;

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly logger: BreakevenLogger
  ) {}

  /** Идемпотентно: повторный вызов при уже запущенном таймере ничего не делает. */
  start(): void {
    if (!this.config.trading.breakevenEnabled) return;
    if (this.timer) return;

    const intervalMs = this.config.trading.breakevenCheckIntervalSec * 1000;
    console.log(`${LOG_TAG} monitor started (interval ${this.config.trading.breakevenCheckIntervalSec}s)`);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
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
          await this.checkPosition(position);
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

    const [instrument, feeRate, stopOrders] = await Promise.all([
      this.client.getInstrumentInfo(symbol),
      this.client.getFeeRate(symbol),
      this.client.getOpenStopOrders(symbol),
    ]);

    // Безубыток с учётом комиссии: цена, при закрытии по которой (по тейкеру, худший случай)
    // суммарные издержки на вход и выход не уводят сделку в минус.
    const roundTripFeeRate = feeRate.takerFeeRate * 2;
    const breakevenPrice = roundToTick(avgPrice * (1 + sign * roundTripFeeRate), instrument.tickSize);

    // Бот всегда ставит SL/TP через setTradingStop в tpslMode "Partial" — под этим режимом
    // Bybit НЕ отражает SL/TP позиции в полях stopLoss/takeProfit самого объекта позиции
    // (getPositionInfo), они существуют только как независимые резидентные ордера
    // (stopOrderType "PartialStopLoss"/"PartialTakeProfit"). Поэтому сверяемся с этими
    // ордерами напрямую, а не с position.stopLoss/position.takeProfit — иначе бот не видит
    // свой же ранее выставленный стоп и пересоздаёт его на каждом тике.
    const existingSl = stopOrders.find((o) => o.stopOrderType === "PartialStopLoss");
    const existingTp = stopOrders.find((o) => o.stopOrderType === "PartialTakeProfit");
    const currentTakeProfit = existingTp ? existingTp.triggerPrice : null;

    // Стоп уже на безубытке или лучше — не отодвигаем его назад и не дёргаем биржу зря на
    // каждом тике.
    const alreadyProtected =
      existingSl !== undefined &&
      (side === "Buy" ? existingSl.triggerPrice >= breakevenPrice : existingSl.triggerPrice <= breakevenPrice);
    if (alreadyProtected) return;

    // Резервный market-SL чуть дальше лимитного безубытка — на случай, если лимитный ордер
    // не успеет исполниться при резком движении (тот же приём, что и для основного SL, см.
    // executor.ts). Дистанция от avgPrice до backup — дистанция до breakeven, увеличенная на
    // тот же множитель.
    const backupFeeRate = roundTripFeeRate * SL_BACKUP_BUFFER_MULTIPLIER;
    const backupPrice = roundToTick(avgPrice * (1 + sign * backupFeeRate), instrument.tickSize);

    try {
      // Чистим все условные ордера риск-менеджмента позиции (Partial SL/TP, независимый
      // backup-SL) перед пересозданием — см. комментарий к getOpenStopOrders в bybit/client.ts:
      // повторный setTradingStop не заменяет старые partial-ордера, а добавляет новые поверх.
      for (const order of stopOrders) {
        await this.client.cancelOrder({ symbol, orderId: order.orderId });
      }

      // SL — лимитным ордером (maker-комиссия), с фоллбэком на market, если лимитник вообще не
      // встал (например, недостаточно ликвидности по цене). TP (если был выставлен) переносим
      // на прежнюю цену — этот шаг его не меняет.
      let appliedSlOrderType: "Limit" | "Market" = "Limit";
      let limitFallbackReason: string | null = null;
      try {
        await this.client.setTradingStop({
          symbol,
          qty: size,
          stopLoss: breakevenPrice,
          stopLossOrderType: "Limit",
          takeProfit: currentTakeProfit,
        });
      } catch (err) {
        appliedSlOrderType = "Market";
        limitFallbackReason = err instanceof Error ? err.message : String(err);
        await this.client.setTradingStop({
          symbol,
          qty: size,
          stopLoss: breakevenPrice,
          stopLossOrderType: "Market",
          takeProfit: currentTakeProfit,
        });
      }

      // Резервный ордер нужен только пока основной действительно лимитный — на market он и так
      // исполняется немедленно по срабатыванию.
      let backupPlaced = false;
      let backupError: string | null = null;
      if (appliedSlOrderType === "Limit") {
        const closingSide: OrderSide = side === "Buy" ? "Sell" : "Buy";
        const triggerDirection: 1 | 2 = side === "Buy" ? 2 : 1;
        try {
          await this.client.submitStopMarketOrder({
            symbol,
            side: closingSide,
            qty: size,
            triggerPrice: backupPrice,
            triggerDirection,
          });
          backupPlaced = true;
        } catch (err) {
          backupError = err instanceof Error ? err.message : String(err);
        }
      }

      const notes = [
        limitFallbackReason ? `limit SL rejected, fell back to market SL: ${limitFallbackReason}` : null,
        backupError ? `backup market SL not set: ${backupError}` : null,
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
      const error = err instanceof Error ? err.message : String(err);
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
      console.error(`${LOG_TAG} ${symbol} failed to move SL to breakeven:`, err);
    }
  }
}
