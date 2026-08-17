import type { AppConfig } from "./config";
import type { BybitClient } from "./bybit/client";
import type { OrdersLogger } from "./logging/ordersLogger";
import type { CascadeSignal, OrderSide } from "./types";
import { resolveOrderSide } from "./decision/filters";
import { calcExitPrices } from "./decision/exits";

// Резервный маркет-SL ставится дальше основного лимитного на этот множитель
// (при stopLossPercent=2% резервный триггер — на 2.2%).
const SL_BACKUP_BUFFER_MULTIPLIER = 1.1;

function roundDownToStep(value: number, step: number): number {
  const rounded = Math.floor(value / step) * step;
  // отбрасываем плавающий "хвост" вида 0.30000000000000004
  const decimals = (step.toString().split(".")[1] ?? "").length;
  return Number(rounded.toFixed(decimals));
}

function roundToTick(value: number, tick: number): number {
  const rounded = Math.round(value / tick) * tick;
  const decimals = (tick.toString().split(".")[1] ?? "").length;
  return Number(rounded.toFixed(decimals));
}

export class OrderExecutor {
  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly ordersLogger: OrdersLogger
  ) {}

  /** Исполнение принятого сигнала. Ошибки логируются, наружу не бросаются. */
  async execute(signal: CascadeSignal): Promise<void> {
    const side: OrderSide = resolveOrderSide(signal.direction);
    // Цену входа не запрашиваем отдельно (getLastPrice убран из критического пути):
    // qty и SL/TP считаем от lastBankruptcyPrice из сигнала (MVP, проскальзывание допустимо).
    const entryPriceRef = signal.lastBankruptcyPrice;
    let qty: number | null = null;
    let sl: number | null = null;
    let slBackup: number | null = null;
    let tp: number | null = null;
    let orderId: string | null = null;

    // Шаг 1 (критический путь): максимально быстрый вход маркет-ордером без SL/TP.
    try {
      const instrument = await this.client.getInstrumentInfo(signal.symbol);

      const rawQty = this.config.trading.positionSizeUsdt / entryPriceRef;
      qty = roundDownToStep(rawQty, instrument.qtyStep);
      if (qty < instrument.minOrderQty) {
        qty = instrument.minOrderQty;
      }

      orderId = await this.client.submitMarketOrder({
        symbol: signal.symbol,
        side,
        qty,
      });

      // Реальную цену входа берём из позиции (ответ submitOrder её не содержит).
      // Если позиция ещё не отразилась — откатываемся на lastBankruptcyPrice.
      let fillPrice = entryPriceRef;
      try {
        fillPrice = await this.client.getPositionAvgPrice(signal.symbol);
      } catch {
        // avgPrice недоступен — считаем SL/TP от lastBankruptcyPrice
      }

      // SL/TP считаем после входа от фактической цены исполнения — не задерживает вход.
      const exits = calcExitPrices(
        side,
        fillPrice,
        this.config.trading.stopLossPercent,
        this.config.trading.takeProfitPercent
      );
      sl = exits.stopLoss !== null ? roundToTick(exits.stopLoss, instrument.tickSize) : null;
      tp = exits.takeProfit !== null ? roundToTick(exits.takeProfit, instrument.tickSize) : null;

      // Резервный маркет-SL считаем заранее (нужен только если основной SL — лимитный).
      if (sl !== null && this.config.trading.stopLossOrderType === "limit" && this.config.trading.stopLossPercent !== null) {
        const backupExits = calcExitPrices(
          side,
          fillPrice,
          this.config.trading.stopLossPercent * SL_BACKUP_BUFFER_MULTIPLIER,
          null
        );
        slBackup = backupExits.stopLoss !== null ? roundToTick(backupExits.stopLoss, instrument.tickSize) : null;
      }

      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef: fillPrice,
        sl,
        slOrderType: null,
        slBackupPrice: null,
        tp,
        status: "filled",
        bybitOrderId: orderId,
        error: null,
      });
    } catch (err) {
      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef,
        sl,
        slOrderType: null,
        slBackupPrice: null,
        tp,
        status: "failed",
        bybitOrderId: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Шаг 2 (вне критического пути): выставляем SL/TP на открытую позицию отдельным запросом.
    if (sl !== null || tp !== null) {
      const preferLimitSl = sl !== null && this.config.trading.stopLossOrderType === "limit";
      let appliedSlOrderType: "Market" | "Limit" | null = sl !== null ? (preferLimitSl ? "Limit" : "Market") : null;

      try {
        await this.client.setTradingStop({
          symbol: signal.symbol,
          qty: qty as number,
          stopLoss: sl,
          stopLossOrderType: appliedSlOrderType ?? "Market",
          takeProfit: tp,
        });
      } catch (err) {
        // Лимитный SL не встал (например, недостаточно ликвидности по цене) — пробуем
        // обычный маркет SL, чтобы не остаться без защиты позиции.
        if (preferLimitSl) {
          appliedSlOrderType = "Market";
          try {
            await this.client.setTradingStop({
              symbol: signal.symbol,
              qty: qty as number,
              stopLoss: sl,
              stopLossOrderType: "Market",
              takeProfit: tp,
            });
          } catch (fallbackErr) {
            this.ordersLogger.log({
              symbol: signal.symbol,
              side,
              qty,
              entryPriceRef,
              sl,
              slOrderType: null,
              slBackupPrice: null,
              tp,
              status: "failed",
              bybitOrderId: orderId,
              error: `SL/TP not set (limit SL failed: ${err instanceof Error ? err.message : String(err)}; market SL fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)})`,
            });
            return;
          }
        } else {
          this.ordersLogger.log({
            symbol: signal.symbol,
            side,
            qty,
            entryPriceRef,
            sl,
            slOrderType: null,
            slBackupPrice: null,
            tp,
            status: "failed",
            bybitOrderId: orderId,
            error: `SL/TP not set: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }

      // Резервный маркет-SL (независимый reduce-only условный ордер) ставим только если
      // основной действительно встал как Limit — если он уже упал на Market, страховка
      // избыточна: Market и так закрывает позицию немедленно по срабатыванию.
      let backupPlaced = false;
      let backupOrderError: string | null = null;
      if (appliedSlOrderType === "Limit" && slBackup !== null) {
        const closingSide: OrderSide = side === "Buy" ? "Sell" : "Buy";
        const triggerDirection: 1 | 2 = side === "Buy" ? 2 : 1;
        try {
          await this.client.submitStopMarketOrder({
            symbol: signal.symbol,
            side: closingSide,
            qty: qty as number,
            triggerPrice: slBackup,
            triggerDirection,
          });
          backupPlaced = true;
        } catch (err) {
          backupOrderError = err instanceof Error ? err.message : String(err);
        }
      }

      const notes = [
        preferLimitSl && appliedSlOrderType === "Market" ? "limit SL rejected, fell back to market SL" : null,
        appliedSlOrderType === "Limit" && slBackup !== null && !backupPlaced
          ? `backup market SL not set: ${backupOrderError}`
          : null,
      ].filter((note): note is string => note !== null);

      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef,
        sl,
        slOrderType: appliedSlOrderType,
        slBackupPrice: appliedSlOrderType === "Limit" && backupPlaced ? slBackup : null,
        tp,
        status: "filled",
        bybitOrderId: orderId,
        error: notes.length > 0 ? notes.join("; ") : null,
      });
    }
  }
}
