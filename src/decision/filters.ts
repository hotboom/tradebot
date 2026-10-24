import type { CascadeSignal, DirectionMode, OrderSide, SignalRejectReason } from "../types";

export interface FilterResult {
  accepted: boolean;
  reason: SignalRejectReason | null;
}

/** Фильтр по разрешённому направлению сделок (both/long/short из настроек). */
export function checkDirection(signal: CascadeSignal, direction: DirectionMode): FilterResult {
  if (direction === "both") {
    return { accepted: true, reason: null };
  }
  if (direction === "long" && signal.direction !== "LONG") {
    return { accepted: false, reason: "direction_filtered" };
  }
  if (direction === "short" && signal.direction !== "SHORT") {
    return { accepted: false, reason: "direction_filtered" };
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
