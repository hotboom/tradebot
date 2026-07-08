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
    // Цену входа не запрашиваем отдельно (getLastPrice убран из критического пути):
    // qty и SL/TP считаем от lastBankruptcyPrice из сигнала (MVP, проскальзывание допустимо).
    const entryPriceRef = signal.lastBankruptcyPrice;
    let qty: number | null = null;
    let sl: number | null = null;
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

      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef: fillPrice,
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
      return;
    }

    // Шаг 2 (вне критического пути): выставляем SL/TP на открытую позицию отдельным запросом.
    if (sl !== null || tp !== null) {
      try {
        await this.client.setTradingStop({
          symbol: signal.symbol,
          stopLoss: sl,
          takeProfit: tp,
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
          bybitOrderId: orderId,
          error: `SL/TP not set: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
}
