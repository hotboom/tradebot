export interface CascadeSignal {
  symbol: string;
  direction: "LONG" | "SHORT";
  totalVolumeUsdt: number;
  orderCount: number;
  lastBankruptcyPrice: number;
  windowMs: number;
  timestamp: number;
}

export type OrderSide = "Buy" | "Sell";

export type SignalDecision = "accepted" | "rejected";
export type SignalRejectReason =
  | "invalid_schema"
  | "below_threshold"
  | "hourly_limit"
  | "trading_paused"
  | "direction_filtered";

export type DirectionMode = "both" | "long" | "short";

export interface SignalLogEntry {
  ts: number;
  eventTs: number | null;
  symbol: string | null;
  direction: string | null;
  totalVolumeUsdt: number | null;
  orderCount: number | null;
  lastBankruptcyPrice: number | null;
  windowMs: number | null;
  decision: SignalDecision;
  reason: SignalRejectReason | null;
}

export type OrderStatus = "submitted" | "filled" | "failed";

export interface OrderLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  qty: number | null;
  entryPriceRef: number;
  sl: number | null;
  tp: number | null;
  status: OrderStatus;
  bybitOrderId: string | null;
  error: string | null;
}
