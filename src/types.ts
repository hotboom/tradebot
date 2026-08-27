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

export type OrderStatus = "submitted" | "filled" | "failed" | "cancelled";

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

export type TrailingStatus = "applied" | "failed";

export interface TrailingLogEntry {
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
  status: TrailingStatus;
  error: string | null;
}

/**
 * Фаза OBI-гейта, в которой сделан этот замер (см. src/obi/obiEntryGate.ts):
 * "waiting_extreme" — ждём подтверждения каскада (сильный дисбаланс в сторону сигнала);
 * "waiting_reversal" — экстремум уже увиден, ждём разворота обратно к нейтральному/противоположному;
 * "post_outcome" — окно гейта уже закрылось (входом или отменой), это пост-трекинг цены/OBI.
 */
export type ObiGatePhase = "waiting_extreme" | "waiting_reversal" | "post_outcome";

export type ObiGateEvent =
  | "sample"
  | "extreme_seen"
  | "triggered"
  | "timeout"
  | "post_sample"
  | "post_summary";

/** OBI по срезу топ-N уровней книги (дублирует imbalance.DepthImbalance — вынесено в types,
 * чтобы ObiLogEntry не зависел от модуля obi/). */
export interface ObiDepthEntry {
  depth: number;
  obi: number;
}

export interface ObiLogEntry {
  ts: number;
  symbol: string;
  direction: CascadeSignal["direction"];
  signalTimestamp: number;
  /** Размер сигнала-каскада — прокинут из CascadeSignal, чтобы obi.log был самодостаточен. */
  signalVolumeUsdt: number;
  signalOrderCount: number;
  elapsedMs: number;
  obi: number;
  /** OBI по срезам топ-1/10/50 той же книги (см. imbalance.OBI_DEPTHS). */
  obiByDepth: ObiDepthEntry[];
  bidVolume: number;
  askVolume: number;
  /** Цены из того же снапшота стакана. */
  bestBid: number;
  bestAsk: number;
  mid: number;
  spreadBps: number;
  phase: ObiGatePhase;
  extremeSeen: boolean;
  event: ObiGateEvent;
  /** Сырой топ книги ([price, size][], лучший первым). Только на событиях extreme_seen /
   * triggered — на остальных отсутствует, чтобы не раздувать лог. */
  topBids?: [number, number][];
  topAsks?: [number, number][];
  /** Только в записи timeout: экстремумы OBI за окно ожидания и на какой миллисекунде окна они
   * были достигнуты (насколько близко книга подходила к extremeThreshold), + число валидных замеров. */
  minObi?: number;
  minObiAtMs?: number;
  maxObi?: number;
  maxObiAtMs?: number;
  sampleCount?: number;
  /** Только в записях post_sample / post_summary: чем закончился гейт по этому сигналу. */
  postOutcome?: "triggered" | "timeout";
  /** Только в записи post_summary: mid в момент исхода (точка отсчёта) и экскурсии цены после
   * него в базисных пунктах, знак — относительно направления ожидавшегося отскока (для LONG
   * благоприятен рост, для SHORT — падение). mfeBps >= 0, maeBps <= 0. */
  refMid?: number;
  mfeBps?: number;
  maeBps?: number;
  postDurationMs?: number;
  postSampleCount?: number;
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
