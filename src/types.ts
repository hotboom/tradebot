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
  | "entry_pending"
  | "invalid_schema"
  | "max_pos_limit"
  | "max_open_positions"
  | "max_open_check_failed"
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

export type OrderStatus = "submitted" | "filled" | "failed" | "cancelled" | "skipped";

export type BreakevenStatus = "applied" | "failed";

export interface BreakevenLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  avgPrice: number;
  markPrice: number;
  /** Цена, от которой считаются profitPercent и стоп (по ней же Bybit триггерит SL). */
  lastPrice: number;
  profitPercent: number;
  previousStopLoss: number | null;
  newStopLoss: number;
  slOrderType: "Limit" | "Market" | null;
  backupStopLoss: number | null;
  status: BreakevenStatus;
  error: string | null;
}

export type TrailingStatus = "applied" | "failed";

export interface TrailingLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  avgPrice: number;
  markPrice: number;
  /** Цена, от которой считаются profitPercent и стоп (по ней же Bybit триггерит SL). */
  lastPrice: number;
  profitPercent: number;
  previousStopLoss: number | null;
  newStopLoss: number;
  slOrderType: "Limit" | "Market" | null;
  backupStopLoss: number | null;
  status: TrailingStatus;
  error: string | null;
}

export type PositionSyncStatus = "applied" | "failed";

export type PositionSyncOrderKind = "TP" | "SL" | "SL_BACKUP";

export interface PositionSyncLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  positionSize: number;
  orderKind: PositionSyncOrderKind;
  orderId: string;
  previousQty: number;
  newQty: number;
  status: PositionSyncStatus;
  error: string | null;
}

export type MarketTpSlConversionStatus = "applied" | "failed";

export interface MarketTpSlConversionLogEntry {
  ts: number;
  symbol: string;
  side: OrderSide;
  positionSize: number;
  /** Какой ордер переделывали: маркетный SL → лимитный SL (+ резервный маркет) или маркетный TP → лимитный TP. */
  leg: "SL" | "TP";
  /** orderId и stopOrderType снятого маркетного ордера. */
  oldOrderId: string;
  oldStopOrderType: string;
  /** Цена нового ордера (= триггер старого маркетного). */
  price: number;
  /** Фактический тип нового SL (Limit, либо Market при фоллбэке); null для TP. */
  slOrderType: "Limit" | "Market" | null;
  /** Триггер резервного market-SL; null — не встал или это TP. */
  backupStopLoss: number | null;
  status: MarketTpSlConversionStatus;
  error: string | null;
}

export interface OrderLogEntry {
  ts: number;
  signalTs?: number;
  entryOrderType?: "market" | "limit" | "offset_limit";
  entryOffsetPercent?: number | null;
  minEntryDistancePercent?: number;
  previousEntryPrice?: number | null;
  actualEntryDistancePercent?: number | null;
  limitPrice?: number | null;
  orderFillPrice?: number | null;
  positionAvgPrice?: number | null;
  entryFilledAt?: number | null;
  entryOutcome?: string;
  symbol: string;
  side: OrderSide;
  qty: number | null;
  entryPriceRef: number;
  /** Initial same-side bid/ask for chase; fetched futures Last for offset; null for market.
   * This is a reference, not a simulated market execution price. */
  refMarketPrice: number | null;
  sl: number | null;
  slOrderType: "Market" | "Limit" | null;
  slBackupPrice: number | null;
  tp: number | null;
  /** Цена и объём частичного TP (partialTpEnabled); null/отсутствует — не ставился. */
  partialTp?: number | null;
  partialTpQty?: number | null;
  status: OrderStatus;
  bybitOrderId: string | null;
  error: string | null;
}
