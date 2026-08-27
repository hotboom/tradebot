import type { BybitClient } from "../bybit/client";
import type { ObiLogger } from "../logging/obiLogger";
import type { CascadeSignal } from "../types";
import { computeImbalance } from "./imbalance";

// Глубина стакана для расчёта OBI. Bybit V5 (category linear) принимает limit только из
// фиксированного набора значений (1/50/200/500) — 50 достаточно, чтобы не реагировать на шум
// одного-двух уровней, и не перегружает расчёт лишними дальними уровнями книги.
const ORDERBOOK_DEPTH = 50;
// Опрос стакана раз в 250мс. С keepAlive-соединением (см. BybitClient) сам запрос стакана ~230мс,
// так что реальный шаг цикла ~480мс и за 10-секундное окно выходит ~20 замеров. Паблик-эндпоинт
// (без подписи) держит такую частоту с большим запасом по rate limit Bybit. Не выносим в конфиг —
// низкоуровневая механика, как REPRICE_INTERVAL_MS в limitChaseEntry.ts.
const POLL_INTERVAL_MS = 250;

export interface ObiGateConfig {
  /** Магнитуда OBI (0..1), за которой книга считается "сильно перекошенной" в сторону сигнала —
   * подтверждает, что каскад действительно идёт (сам по себе входом не является). */
  extremeThreshold: number;
  /** Уровень OBI, до которого должен произойти откат от экстремума, чтобы считать это разворотом
   * и открыть позицию. 0 = нейтральный стакан; положительное значение требует более уверенного
   * разворота в противоположную сторону, отрицательное — допускает вход чуть раньше нейтрали. */
  reversalThreshold: number;
  /** Сколько секунд после сигнала ждём разворот, прежде чем отменить попытку входа целиком. */
  windowSec: number;
}

export type ObiGateResult =
  | { triggered: true; obi: number; elapsedMs: number }
  | { triggered: false; reason: "timeout"; extremeSeen: boolean; lastObi: number | null; elapsedMs: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Экстремум в сторону сигнала: LONG (ликвидированы лонги, цена падала) — сильный перевес asks
 * (OBI сильно отрицательный); SHORT — сильный перевес bids (OBI сильно положительный). */
function isExtremeForDirection(direction: CascadeSignal["direction"], obi: number, threshold: number): boolean {
  return direction === "LONG" ? obi <= -threshold : obi >= threshold;
}

/** Разворот после экстремума: LONG ждёт возврата к нейтральному/положительному OBI (книга снова
 * наполняется бидами — падение выдыхается), SHORT — зеркально к нейтральному/отрицательному. */
function isReversedForDirection(direction: CascadeSignal["direction"], obi: number, threshold: number): boolean {
  return direction === "LONG" ? obi >= threshold : obi <= -threshold;
}

/**
 * После сигнала о каскаде ликвидаций вход не открывается сразу — бот отслеживает баланс стакана
 * (OBI, order book imbalance) и ждёт не сам дисбаланс в сторону сигнала (это лишь подтверждает,
 * что каскад идёт), а его разворот к нейтральному/противоположному значению — признак того, что
 * давление каскада выдыхается и вероятен отскок. Если разворот не произошёл за `windowSec` секунд
 * после сигнала, попытка входа отменяется целиком — без ожидания сверх лимита и без входа по
 * маркету "на всякий случай".
 *
 * Каждый замер OBI пишется в obi.log (см. ObiLogger) — в том числе когда экстремум так и не был
 * увиден или разворот не случился — для последующего анализа поведения книги во время каскадов.
 */
export async function waitForObiReversal(
  client: BybitClient,
  obiLogger: ObiLogger,
  signal: CascadeSignal,
  config: ObiGateConfig
): Promise<ObiGateResult> {
  const startedAt = Date.now();
  const deadline = startedAt + config.windowSec * 1000;
  let extremeSeen = false;
  let lastObi: number | null = null;

  while (true) {
    const now = Date.now();
    const elapsedMs = now - startedAt;

    try {
      const book = await client.getOrderbookDepth(signal.symbol, ORDERBOOK_DEPTH);
      const sample = computeImbalance(book);
      lastObi = sample.obi;

      const wasExtremeSeen = extremeSeen;
      if (!extremeSeen && isExtremeForDirection(signal.direction, sample.obi, config.extremeThreshold)) {
        extremeSeen = true;
      }

      const phase = extremeSeen ? "waiting_reversal" : "waiting_extreme";
      const triggered = extremeSeen && isReversedForDirection(signal.direction, sample.obi, config.reversalThreshold);

      obiLogger.log({
        symbol: signal.symbol,
        direction: signal.direction,
        signalTimestamp: signal.timestamp,
        elapsedMs,
        obi: sample.obi,
        bidVolume: sample.bidVolume,
        askVolume: sample.askVolume,
        phase,
        extremeSeen,
        event: triggered ? "triggered" : !wasExtremeSeen && extremeSeen ? "extreme_seen" : "sample",
      });

      if (triggered) {
        return { triggered: true, obi: sample.obi, elapsedMs };
      }
    } catch {
      // Сбой запроса стакана (сеть/rate limit) — пропускаем этот замер, пробуем снова на
      // следующем тике в пределах общего окна ожидания; ничего не логируем (нет валидного замера).
    }

    if (Date.now() >= deadline) {
      const finalElapsedMs = Date.now() - startedAt;
      obiLogger.log({
        symbol: signal.symbol,
        direction: signal.direction,
        signalTimestamp: signal.timestamp,
        elapsedMs: finalElapsedMs,
        obi: lastObi ?? 0,
        bidVolume: 0,
        askVolume: 0,
        phase: extremeSeen ? "waiting_reversal" : "waiting_extreme",
        extremeSeen,
        event: "timeout",
      });
      return { triggered: false, reason: "timeout", extremeSeen, lastObi, elapsedMs: finalElapsedMs };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
