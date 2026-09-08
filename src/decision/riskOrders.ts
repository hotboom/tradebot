import type { BybitClient } from "../bybit/client";
import type { OrderSide } from "../types";

/**
 * Ордер риск-менеджмента позиции из snapshot getOpenStopOrders, снятого ДО замены стопа.
 * Отменяем такие ордера только после того, как новый SL реально встал (см. replacePositionStop).
 */
export interface StaleRiskOrder {
  orderId: string;
  stopOrderType: string;
}

export interface ReplacePositionStopParams {
  symbol: string;
  /** Сторона самой позиции ("Buy" — лонг, "Sell" — шорт). */
  positionSide: OrderSide;
  /** Полный объём позиции — на него сайзим SL и резервный ордер. */
  size: number;
  stopLoss: number;
  /** Желаемый тип основного SL; при отказе биржи по лимитному делаем фоллбэк на Market. */
  stopLossOrderType: "Limit" | "Market";
  /** Триггер независимого резервного market-SL (ставится только если основной остался Limit). */
  backupStopLoss: number | null;
  /** Ордера риск-менеджмента позиции, которые надо снять ПОСЛЕ установки нового SL. */
  staleOrders: StaleRiskOrder[];
}

export interface ReplacePositionStopResult {
  appliedSlOrderType: "Limit" | "Market";
  limitFallbackReason: string | null;
  backupPlaced: boolean;
  backupError: string | null;
  cleanupError: string | null;
}

/**
 * SL допустим только по «правильную» сторону текущей цены: для шорта (Sell) — строго выше
 * LastPrice, для лонга (Buy) — строго ниже. Иначе Bybit отбивает setTradingStop с retCode
 * 10001 ("...PartialStopLoss... should greater/less base_price... LastPrice"). На резко
 * пилящем рынке (например, в момент каскада ликвидаций, что и породил сигнал) цена,
 * посчитанная от markPrice из snapshot позиции, легко оказывается уже не с той стороны — в
 * этом случае мониторы просто не трогают существующий стоп и ждут следующего тика.
 */
export function stopLossOnValidSide(
  positionSide: OrderSide,
  stopLoss: number,
  lastPrice: number
): boolean {
  if (!Number.isFinite(stopLoss) || !Number.isFinite(lastPrice) || stopLoss <= 0) return false;
  return positionSide === "Sell" ? stopLoss > lastPrice : stopLoss < lastPrice;
}

/**
 * Ставит новый SL на позицию ДО отмены старого (place-before-cancel).
 *
 * В tpslMode "Partial" повторный setTradingStop НЕ заменяет существующий partial-ордер, а
 * добавляет новый поверх (проверено на боевом аккаунте), поэтому на короткое время у позиции
 * два SL — это осознанная переподстраховка: оба ордера reduce-only, лишний отменяется сразу
 * после. Старые ордера риск-менеджмента (Partial SL + независимый backup-SL) снимаем только
 * ПОСЛЕ того, как новый SL подтверждён.
 *
 * Если новый SL не удалось поставить ни лимитным, ни маркетом — бросаем ошибку, НЕ тронув
 * старые ордера: позиция остаётся под защитой прежнего стопа (раньше здесь старый SL уже был
 * снят, и позиция оставалась голой — см. инцидент BNCUSDT 2026-09-08).
 *
 * Легаси PartialTakeProfit (у позиций, открытых до перехода на лимитный TP) не трогаем — TP
 * теперь живёт отдельным reduce-only лимитником.
 */
export async function replacePositionStop(
  client: BybitClient,
  params: ReplacePositionStopParams
): Promise<ReplacePositionStopResult> {
  const { symbol, positionSide, size } = params;

  // 1. Новый SL — сначала желаемым типом, при отказе биржи по лимитному фоллбэк на market,
  //    чтобы не остаться без защиты.
  let appliedSlOrderType: "Limit" | "Market" = params.stopLossOrderType;
  let limitFallbackReason: string | null = null;
  try {
    await client.setTradingStop({
      symbol,
      qty: size,
      stopLoss: params.stopLoss,
      stopLossOrderType: appliedSlOrderType,
    });
  } catch (err) {
    if (appliedSlOrderType !== "Limit") throw err;
    limitFallbackReason = err instanceof Error ? err.message : String(err);
    appliedSlOrderType = "Market";
    await client.setTradingStop({
      symbol,
      qty: size,
      stopLoss: params.stopLoss,
      stopLossOrderType: "Market",
    });
  }

  // 2. Резервный market-SL — только если основной действительно встал как Limit (на Market он
  //    и так исполняется немедленно по срабатыванию).
  let backupPlaced = false;
  let backupError: string | null = null;
  if (appliedSlOrderType === "Limit" && params.backupStopLoss !== null) {
    const closingSide: OrderSide = positionSide === "Buy" ? "Sell" : "Buy";
    const triggerDirection: 1 | 2 = positionSide === "Buy" ? 2 : 1;
    try {
      await client.submitStopMarketOrder({
        symbol,
        side: closingSide,
        qty: size,
        triggerPrice: params.backupStopLoss,
        triggerDirection,
      });
      backupPlaced = true;
    } catch (err) {
      backupError = err instanceof Error ? err.message : String(err);
    }
  }

  // 3. Новый SL подтверждён — теперь снимаем старые ордера риск-менеджмента позиции.
  let cleanupError: string | null = null;
  for (const order of params.staleOrders) {
    if (order.stopOrderType === "PartialTakeProfit") continue;
    try {
      await client.cancelOrder({ symbol, orderId: order.orderId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleanupError = cleanupError ? `${cleanupError}; ${msg}` : msg;
    }
  }

  return { appliedSlOrderType, limitFallbackReason, backupPlaced, backupError, cleanupError };
}
