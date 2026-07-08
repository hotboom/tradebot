import type { OrderSide } from "../types";

export interface ExitPrices {
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * Расчёт SL/TP от ориентировочной цены входа.
 * Каждый из процентов опционален (null — параметр не выставляется).
 */
export function calcExitPrices(
  side: OrderSide,
  entryPrice: number,
  stopLossPercent: number | null,
  takeProfitPercent: number | null
): ExitPrices {
  const sign = side === "Buy" ? 1 : -1;
  return {
    stopLoss:
      stopLossPercent !== null ? entryPrice * (1 - (sign * stopLossPercent) / 100) : null,
    takeProfit:
      takeProfitPercent !== null ? entryPrice * (1 + (sign * takeProfitPercent) / 100) : null,
  };
}
