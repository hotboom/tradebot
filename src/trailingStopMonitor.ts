import type { AppConfig } from "./config";
import type { BybitClient, OpenPositionSummary } from "./bybit/client";
import type { TrailingLogger } from "./logging/trailingLogger";
import type { OrderSide } from "./types";
import { SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
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
 * успешного открытия позиции (см. executor.ts) и на старте процесса (см. server.ts) — если
 * открытых позиций нет, первый же тик сам себя останавливает (clearInterval).
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

    const [instrument, stopOrders] = await Promise.all([
      this.client.getInstrumentInfo(symbol),
      this.client.getOpenStopOrders(symbol),
    ]);

    const trailingDistance = this.config.trading.trailingStopPercent / 100;
    // Кандидат — на trailingStopPercent хуже ТЕКУЩЕЙ цены (не от входа), как и должен себя
    // вести trailing-stop.
    const candidatePrice = roundToTick(markPrice * (1 - sign * trailingDistance), instrument.tickSize);

    // См. комментарий в breakevenMonitor.ts про tpslMode "Partial": SL/TP позиции видны только
    // как независимые резидентные ордера (stopOrderType "PartialStopLoss"/"PartialTakeProfit"),
    // а не в полях position.stopLoss/position.takeProfit.
    const existingSl = stopOrders.find((o) => o.stopOrderType === "PartialStopLoss");
    const existingTp = stopOrders.find((o) => o.stopOrderType === "PartialTakeProfit");
    const currentTakeProfit = existingTp ? existingTp.triggerPrice : null;

    // Подтягиваем стоп только в сторону прибыли — если цена откатилась против позиции,
    // кандидат хуже уже выставленного стопа, и мы его не трогаем.
    const isImprovement =
      existingSl === undefined ||
      (side === "Buy" ? candidatePrice > existingSl.triggerPrice : candidatePrice < existingSl.triggerPrice);
    if (!isImprovement) return;

    const backupPrice = roundToTick(
      markPrice * (1 - sign * trailingDistance * SL_BACKUP_BUFFER_MULTIPLIER),
      instrument.tickSize
    );

    try {
      // Чистим все условные ордера риск-менеджмента позиции перед пересозданием — см.
      // комментарий к getOpenStopOrders в bybit/client.ts.
      for (const order of stopOrders) {
        await this.client.cancelOrder({ symbol, orderId: order.orderId });
      }

      let appliedSlOrderType: "Limit" | "Market" = "Limit";
      let limitFallbackReason: string | null = null;
      try {
        await this.client.setTradingStop({
          symbol,
          qty: size,
          stopLoss: candidatePrice,
          stopLossOrderType: "Limit",
          takeProfit: currentTakeProfit,
        });
      } catch (err) {
        appliedSlOrderType = "Market";
        limitFallbackReason = err instanceof Error ? err.message : String(err);
        await this.client.setTradingStop({
          symbol,
          qty: size,
          stopLoss: candidatePrice,
          stopLossOrderType: "Market",
          takeProfit: currentTakeProfit,
        });
      }

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
      const error = err instanceof Error ? err.message : String(err);
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
      console.error(`${LOG_TAG} ${symbol} failed to trail SL:`, err);
    }
  }
}
