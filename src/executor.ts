import type { AppConfig } from "./config";
import type { BybitClient } from "./bybit/client";
import type { OrdersLogger } from "./logging/ordersLogger";
import type { CascadeSignal, OrderSide } from "./types";
import { resolveOrderSide } from "./decision/filters";
import { calcExitPrices } from "./decision/exits";

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
    // Ориентировочная цена входа для расчёта qty и SL/TP (MVP)
    let entryPriceRef = signal.lastBankruptcyPrice;
    let qty: number | null = null;
    let sl: number | null = null;
    let tp: number | null = null;

    try {
      const instrument = await this.client.getInstrumentInfo(signal.symbol);

      try {
        entryPriceRef = await this.client.getLastPrice(signal.symbol);
      } catch {
        // тикер недоступен — остаёмся на lastBankruptcyPrice из сигнала
      }

      const rawQty = this.config.trading.positionSizeUsdt / entryPriceRef;
      qty = roundDownToStep(rawQty, instrument.qtyStep);
      if (qty < instrument.minOrderQty) {
        qty = instrument.minOrderQty;
      }

      const exits = calcExitPrices(
        side,
        entryPriceRef,
        this.config.trading.stopLossPercent,
        this.config.trading.takeProfitPercent
      );
      sl = exits.stopLoss !== null ? roundToTick(exits.stopLoss, instrument.tickSize) : null;
      tp = exits.takeProfit !== null ? roundToTick(exits.takeProfit, instrument.tickSize) : null;

      const orderId = await this.client.submitMarketOrder({
        symbol: signal.symbol,
        side,
        qty,
        stopLoss: sl,
        takeProfit: tp,
      });

      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef,
        sl,
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
        tp,
        status: "failed",
        bybitOrderId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
