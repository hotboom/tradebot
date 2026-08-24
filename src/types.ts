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

export type BreakevenStatus = "applied" | "failed";

export interface BreakevenLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  avgPrice: number;
  markPrice: number;
  profitPercent: number;
  previousStopLoss: number | null;
  newStopLoss: number;
  slOrderType: "Limit" | "Market" | null;
  backupStopLoss: number | null;
  status: BreakevenStatus;
  error: string | null;
}

export interface OrderLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  qty: number | null;
  entryPriceRef: number;
  /** Лучшая цена нашей стороны стакана в момент старта лимитного чейза (best bid для Buy /
   * best ask для Sell) — то, по чему исполнился бы маркет-ордер вместо чейза. Только для
   * entryOrderType: "limit"; null для маркет-входа (там незачем платить лишним запросом
   * к стакану на критическом пути). Для сравнения фактической цены чейза с гипотетическим
   * маркет-входом постфактум. */
  refMarketPrice: number | null;
  sl: number | null;
  slOrderType: "Market" | "Limit" | null;
  slBackupPrice: number | null;
  tp: number | null;
  status: OrderStatus;
  bybitOrderId: string | null;
  error: string | null;
}
