import type { BybitClient, OrderbookTop } from "./client";
import type { OrderSide } from "../types";

const REPRICE_INTERVAL_MS = 400;

export interface ChaseEntryParams {
  symbol: string;
  side: OrderSide;
  qty: number;
}

export interface ChaseEntryResult {
  filledQty: number;
  avgPrice: number;
  lastOrderId: string;
  /** Лучшая цена нашей стороны стакана на момент самого первого обращения к нему (до первого
   * сабмита) — то, по чему исполнился бы маркет-ордер вместо чейза. Для постфактумного
   * сравнения факта (avgPrice) с гипотетическим маркет-входом. */
  refPrice: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bestPriceForSide(side: OrderSide, book: OrderbookTop): number {
  return side === "Buy" ? book.bestBid : book.bestAsk;
}

/**
 * Чейзит вход лимитным PostOnly-ордером на best bid/ask, репрайся по мере движения стакана,
 * пока весь запрошенный объём не исполнится полностью. Без таймаута — резолвится только
 * после полного исполнения, сколько бы это ни заняло (см. план: маркет-фоллбэк здесь
 * сознательно не нужен).
 */
export async function chaseLimitEntry(client: BybitClient, params: ChaseEntryParams): Promise<ChaseEntryResult> {
  const { symbol, side, qty } = params;

  let filledQty = 0;
  let filledValue = 0; // сумма price*qty по всем исполненным партиям — для блендед avgPrice
  let orderId: string | null = null;
  let restingPrice: number | null = null;
  let currentOrderFilledQty = 0;
  let refPrice = 0;
  let refPriceCaptured = false;

  async function submitFresh(remainingQty: number): Promise<void> {
    const book = await client.getOrderbook(symbol);
    const price = bestPriceForSide(side, book);
    if (!refPriceCaptured) {
      // Фиксируем только на самом первом обращении к стакану — это "цена сигнала",
      // последующие пересабмиты после PostOnly-реджекта её не переписывают.
      refPrice = price;
      refPriceCaptured = true;
    }
    orderId = await client.submitLimitOrder({ symbol, side, qty: remainingQty, price });
    restingPrice = price;
    currentOrderFilledQty = 0;
  }

  await submitFresh(qty);

  let skipSleep = false;
  while (filledQty < qty) {
    if (!skipSleep) {
      await sleep(REPRICE_INTERVAL_MS);
    }
    skipSleep = false;

    if (!orderId) {
      await submitFresh(qty - filledQty);
      continue;
    }

    const state = await client.getOrderState(symbol, orderId);
    if (!state) {
      // Не нашли нигде (не должно случаться в норме) — пересабмитим остаток на всякий случай.
      orderId = null;
      continue;
    }

    const deltaQty = state.cumExecQty - currentOrderFilledQty;
    if (deltaQty > 0) {
      filledValue += deltaQty * state.avgPrice;
      filledQty += deltaQty;
      currentOrderFilledQty = state.cumExecQty;
    }
    if (filledQty >= qty) break;

    if (
      state.orderStatus === "Rejected" ||
      state.orderStatus === "Cancelled" ||
      state.orderStatus === "PartiallyFilledCanceled"
    ) {
      // Ордер больше не живёт на бирже (чаще всего PostOnly отклонён на пересечённой цене) —
      // пересабмитим остаток новым ордером на текущий best bid/ask.
      orderId = null;
      continue;
    }

    // New / PartiallyFilled — ордер ещё резидентный на бирже, догоняем книгу при необходимости.
    const book = await client.getOrderbook(symbol);
    const desiredPrice = bestPriceForSide(side, book);
    if (desiredPrice !== restingPrice) {
      const amendResult = await client.amendOrder({ symbol, orderId, price: desiredPrice });
      if (amendResult === "gone") {
        // Заполнился/пропал между опросом статуса и амендом — сразу переопрашиваем, без ожидания.
        skipSleep = true;
        continue;
      }
      restingPrice = desiredPrice;
    }
  }

  return {
    filledQty,
    avgPrice: filledQty > 0 ? filledValue / filledQty : 0,
    lastOrderId: orderId ?? "",
    refPrice,
  };
}
