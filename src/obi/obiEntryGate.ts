import type { BybitClient } from "../bybit/client";
import type { ObiLogger } from "../logging/obiLogger";
import type { CascadeSignal, ObiGateEvent, ObiGatePhase, ObiLogEntry } from "../types";
import { computeImbalance, OBI_DEPTHS, type ObiSample } from "./imbalance";

// Глубина стакана для расчёта OBI. Bybit V5 (category linear) принимает limit только из
// фиксированного набора значений (1/50/200/500) — 50 достаточно, чтобы не реагировать на шум
// одного-двух уровней, и не перегружает расчёт лишними дальними уровнями книги. OBI по срезам
// топ-1/10/50 этой же книги считается в computeImbalance без дополнительных запросов.
const ORDERBOOK_DEPTH = 50;
// Опрос стакана раз в 250мс. С keepAlive-соединением (см. BybitClient) сам запрос стакана ~230мс,
// так что реальный шаг цикла ~480мс и за 10-секундное окно выходит ~20 замеров. Паблик-эндпоинт
// (без подписи) держит такую частоту с большим запасом по rate limit Bybit. Не выносим в конфиг —
// низкоуровневая механика, как REPRICE_INTERVAL_MS в limitChaseEntry.ts.
const POLL_INTERVAL_MS = 250;

// Сколько верхних уровней книги пишем сырьём (topBids/topAsks) в лог на событиях extreme_seen /
// triggered — чтобы можно было посмотреть форму книги в ключевые моменты, не раздувая каждый замер.
const RAW_BOOK_DUMP_LEVELS = 10;

// Пост-трекинг после закрытия окна гейта (см. trackObiAfterOutcome): ещё столько времени с таким
// шагом опрашиваем стакан — и после входа, и после отмены — чтобы задним числом оценить, был ли
// разворот настоящим и что дала бы отменённая попытка. 120с/2с = ~60 замеров на сигнал,
// публичный эндпоинт это держит с запасом. Не в конфиге — та же низкоуровневая механика.
const POST_OUTCOME_DURATION_MS = 120_000;
const POST_OUTCOME_INTERVAL_MS = 2_000;

/** Заглушка на случай записи, для которой нет ни одного валидного замера книги (все запросы
 * стакана в окне упали) — чтобы поля цен/объёмов в логе были нулями, а не отсутствовали. */
const ZERO_SAMPLE: ObiSample = {
  obi: 0,
  bidVolume: 0,
  askVolume: 0,
  bestBid: 0,
  bestAsk: 0,
  mid: 0,
  spreadBps: 0,
  obiByDepth: OBI_DEPTHS.map((depth) => ({ depth, obi: 0 })),
};

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
  | { triggered: true; obi: number; elapsedMs: number; mid: number }
  | {
      triggered: false;
      reason: "timeout";
      extremeSeen: boolean;
      lastObi: number | null;
      elapsedMs: number;
      /** mid из последнего валидного замера (точка отсчёта для пост-трекинга), либо null. */
      mid: number | null;
    };

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

/** Общие поля записи obi.log из сигнала и замера книги. Опциональные поля (topBids, minObi,
 * MFE/MAE и т.п.) дописываются вызывающим кодом под конкретное событие. */
function baseObiEntry(
  signal: CascadeSignal,
  elapsedMs: number,
  sample: ObiSample,
  phase: ObiGatePhase,
  extremeSeen: boolean,
  event: ObiGateEvent
): Omit<ObiLogEntry, "ts"> {
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    signalTimestamp: signal.timestamp,
    signalVolumeUsdt: signal.totalVolumeUsdt,
    signalOrderCount: signal.orderCount,
    elapsedMs,
    obi: sample.obi,
    obiByDepth: sample.obiByDepth,
    bidVolume: sample.bidVolume,
    askVolume: sample.askVolume,
    bestBid: sample.bestBid,
    bestAsk: sample.bestAsk,
    mid: sample.mid,
    spreadBps: sample.spreadBps,
    phase,
    extremeSeen,
    event,
  };
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
 * Запись timeout дополнительно несёт экстремумы OBI за окно (minObi/maxObi + когда), запись
 * extreme_seen/triggered — сырой топ книги. Пост-трекинг цены после исхода — trackObiAfterOutcome.
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
  let lastSample: ObiSample | null = null;
  let lastElapsedMs = 0;
  let sampleCount = 0;
  let minObi = Infinity;
  let minObiAtMs = 0;
  let maxObi = -Infinity;
  let maxObiAtMs = 0;

  while (true) {
    const elapsedMs = Date.now() - startedAt;

    try {
      const book = await client.getOrderbookDepth(signal.symbol, ORDERBOOK_DEPTH);
      const sample = computeImbalance(book);
      lastObi = sample.obi;
      lastSample = sample;
      lastElapsedMs = elapsedMs;
      sampleCount += 1;
      if (sample.obi < minObi) {
        minObi = sample.obi;
        minObiAtMs = elapsedMs;
      }
      if (sample.obi > maxObi) {
        maxObi = sample.obi;
        maxObiAtMs = elapsedMs;
      }

      const wasExtremeSeen = extremeSeen;
      if (!extremeSeen && isExtremeForDirection(signal.direction, sample.obi, config.extremeThreshold)) {
        extremeSeen = true;
      }

      const phase: ObiGatePhase = extremeSeen ? "waiting_reversal" : "waiting_extreme";
      const triggered =
        extremeSeen && isReversedForDirection(signal.direction, sample.obi, config.reversalThreshold);
      const event: ObiGateEvent = triggered
        ? "triggered"
        : !wasExtremeSeen && extremeSeen
          ? "extreme_seen"
          : "sample";

      const entry = baseObiEntry(signal, elapsedMs, sample, phase, extremeSeen, event);
      if (event === "extreme_seen" || event === "triggered") {
        entry.topBids = book.bids.slice(0, RAW_BOOK_DUMP_LEVELS);
        entry.topAsks = book.asks.slice(0, RAW_BOOK_DUMP_LEVELS);
      }
      obiLogger.log(entry);

      if (triggered) {
        return { triggered: true, obi: sample.obi, elapsedMs, mid: sample.mid };
      }
    } catch {
      // Сбой запроса стакана (сеть/rate limit) — пропускаем этот замер, пробуем снова на
      // следующем тике в пределах общего окна ожидания.
    }

    if (Date.now() >= deadline) {
      const phase: ObiGatePhase = extremeSeen ? "waiting_reversal" : "waiting_extreme";
      // elapsedMs записи timeout — момент последнего валидного замера (obi/цены в записи от
      // него же); если валидных замеров не было — момент закрытия окна.
      const entry = baseObiEntry(
        signal,
        lastSample ? lastElapsedMs : Date.now() - startedAt,
        lastSample ?? ZERO_SAMPLE,
        phase,
        extremeSeen,
        "timeout"
      );
      if (sampleCount > 0) {
        entry.minObi = minObi;
        entry.minObiAtMs = minObiAtMs;
        entry.maxObi = maxObi;
        entry.maxObiAtMs = maxObiAtMs;
      }
      entry.sampleCount = sampleCount;
      obiLogger.log(entry);
      return {
        triggered: false,
        reason: "timeout",
        extremeSeen,
        lastObi,
        elapsedMs: Date.now() - startedAt,
        mid: lastSample?.mid ?? null,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Пост-трекинг после закрытия окна гейта: ещё POST_OUTCOME_DURATION_MS опрашивает стакан по
 * символу и пишет цену/OBI в obi.log (event "post_sample"), в конце — сводку (event
 * "post_summary") с экскурсиями цены относительно `referenceMid`. По входам это показывает,
 * был ли разворот настоящим (MFE против MAE), по отменам — что дала бы несделанная сделка.
 *
 * Запускается detached из executor'а: не блокирует вход и обработку других сигналов, наружу
 * не бросает. `referenceMid` — mid из последнего замера гейта; если null (окно закрылось без
 * единого валидного замера), точкой отсчёта станет mid первого пост-замера.
 *
 * `mfeBps`/`maeBps` считаются в системе координат ожидавшегося отскока: для сигнала LONG (ловим
 * отскок вверх после падения) благоприятен рост mid, для SHORT — падение. mfeBps >= 0, maeBps <= 0.
 */
export async function trackObiAfterOutcome(
  client: BybitClient,
  obiLogger: ObiLogger,
  signal: CascadeSignal,
  outcome: "triggered" | "timeout",
  extremeSeen: boolean,
  referenceMid: number | null
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + POST_OUTCOME_DURATION_MS;
  let refMid = referenceMid !== null && referenceMid > 0 ? referenceMid : null;
  let mfeBps = 0;
  let maeBps = 0;
  let postSampleCount = 0;
  let lastSample: ObiSample | null = null;

  while (Date.now() < deadline) {
    try {
      const book = await client.getOrderbookDepth(signal.symbol, ORDERBOOK_DEPTH);
      const sample = computeImbalance(book);
      lastSample = sample;
      const elapsedMs = Date.now() - startedAt;

      if (sample.mid > 0) {
        if (refMid === null) {
          refMid = sample.mid;
        }
        const changeBps = ((sample.mid - refMid) / refMid) * 10000;
        const favBps = signal.direction === "LONG" ? changeBps : -changeBps;
        mfeBps = Math.max(mfeBps, favBps);
        maeBps = Math.min(maeBps, favBps);
        postSampleCount += 1;
      }

      const entry = baseObiEntry(signal, elapsedMs, sample, "post_outcome", extremeSeen, "post_sample");
      entry.postOutcome = outcome;
      obiLogger.log(entry);
    } catch {
      // пропускаем тик — следующий в пределах общего окна пост-трекинга
    }
    await sleep(POST_OUTCOME_INTERVAL_MS);
  }

  const summary = baseObiEntry(
    signal,
    Date.now() - startedAt,
    lastSample ?? ZERO_SAMPLE,
    "post_outcome",
    extremeSeen,
    "post_summary"
  );
  summary.postOutcome = outcome;
  summary.refMid = refMid ?? undefined;
  summary.mfeBps = mfeBps;
  summary.maeBps = maeBps;
  summary.postDurationMs = Date.now() - startedAt;
  summary.postSampleCount = postSampleCount;
  obiLogger.log(summary);
}
