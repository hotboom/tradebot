export interface OrderbookLevels {
  /** [price, size][], лучший уровень первым (как возвращает Bybit). */
  bids: [number, number][];
  asks: [number, number][];
}

export interface ObiSample {
  obi: number;
  bidVolume: number;
  askVolume: number;
}

/**
 * Order book imbalance по сумме объёмов топ-N уровней: (bidVol - askVol) / (bidVol + askVol).
 * В диапазоне [-1, 1]; отрицательный — перевес продавцов (asks), положительный — покупателей (bids).
 * Пустой/нулевой стакан (bidVolume + askVolume === 0) даёт obi: 0 — нейтрально, а не деление на ноль.
 */
export function computeImbalance(book: OrderbookLevels): ObiSample {
  const bidVolume = book.bids.reduce((sum, [, size]) => sum + size, 0);
  const askVolume = book.asks.reduce((sum, [, size]) => sum + size, 0);
  const total = bidVolume + askVolume;
  const obi = total > 0 ? (bidVolume - askVolume) / total : 0;
  return { obi, bidVolume, askVolume };
}
