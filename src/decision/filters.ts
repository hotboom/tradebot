import type { CascadeSignal, OrderSide, SignalRejectReason } from "../types";

export interface FilterResult {
  accepted: boolean;
  reason: SignalRejectReason | null;
}

/** Проверка порога объёма ликвидаций. */
export function checkThreshold(signal: CascadeSignal, minLiquidationUsdt: number): FilterResult {
  if (signal.totalVolumeUsdt < minLiquidationUsdt) {
    return { accepted: false, reason: "below_threshold" };
  }
  return { accepted: true, reason: null };
}

/**
 * Направление сделки: открываемся в ту же сторону, что и ликвидированные позиции.
 * LONG (ликвидированы лонги) -> Buy, SHORT (ликвидированы шорты) -> Sell.
 */
export function resolveOrderSide(direction: CascadeSignal["direction"]): OrderSide {
  return direction === "LONG" ? "Buy" : "Sell";
}
