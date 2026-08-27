export interface OrderbookLevels {
  /** [price, size][], лучший уровень первым (как возвращает Bybit). */
  bids: [number, number][];
  asks: [number, number][];
}

/** OBI, посчитанный по срезу топ-N уровней той же книги. */
export interface DepthImbalance {
  /** Сколько верхних уровней книги учтено (1 / 10 / 50). */
  depth: number;
  obi: number;
}

export interface ObiSample {
  obi: number;
  bidVolume: number;
  askVolume: number;
  /** Лучший бид/аск и производные — из того же снапшота стакана. bestBid/bestAsk = 0,
   * если соответствующей стороны книги нет. */
  bestBid: number;
  bestAsk: number;
  mid: number;
  /** Спред в базисных пунктах от mid ((ask - bid) / mid * 10000). 0, если mid неизвестен. */
  spreadBps: number;
  /** OBI по срезам топ-1 / топ-10 / топ-50 уровней — чтобы видеть, двигается верх книги или
   * дальние уровни, и сравнивать символы с разной плотностью стакана (топ-50 у BTC — узкая
   * полоса возле цены, у альткоина — широкая). */
  obiByDepth: DepthImbalance[];
}

/** Глубины (в уровнях книги), для которых считаем OBI дополнительно к полному срезу. */
export const OBI_DEPTHS = [1, 10, 50] as const;

function imbalanceOf(bidVolume: number, askVolume: number): number {
  const total = bidVolume + askVolume;
  return total > 0 ? (bidVolume - askVolume) / total : 0;
}

function sumSizes(levels: [number, number][], depth?: number): number {
  const slice = depth === undefined ? levels : levels.slice(0, depth);
  return slice.reduce((sum, [, size]) => sum + size, 0);
}

/**
 * Order book imbalance по сумме объёмов уровней: (bidVol - askVol) / (bidVol + askVol).
 * В диапазоне [-1, 1]; отрицательный — перевес продавцов (asks), положительный — покупателей (bids).
 * Пустой/нулевой стакан (bidVolume + askVolume === 0) даёт obi: 0 — нейтрально, а не деление на ноль.
 *
 * `obi` считается по всем переданным уровням; `obiByDepth` — по срезам топ-N (см. OBI_DEPTHS).
 */
export function computeImbalance(book: OrderbookLevels): ObiSample {
  const bidVolume = sumSizes(book.bids);
  const askVolume = sumSizes(book.asks);

  const bestBid = book.bids[0]?.[0] ?? 0;
  const bestAsk = book.asks[0]?.[0] ?? 0;
  const hasBoth = bestBid > 0 && bestAsk > 0;
  const mid = hasBoth ? (bestBid + bestAsk) / 2 : 0;
  const spreadBps = hasBoth ? ((bestAsk - bestBid) / mid) * 10000 : 0;

  const obiByDepth: DepthImbalance[] = OBI_DEPTHS.map((depth) => ({
    depth,
    obi: imbalanceOf(sumSizes(book.bids, depth), sumSizes(book.asks, depth)),
  }));

  return {
    obi: imbalanceOf(bidVolume, askVolume),
    bidVolume,
    askVolume,
    bestBid,
    bestAsk,
    mid,
    spreadBps,
    obiByDepth,
  };
}
