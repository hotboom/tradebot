/**
 * Per-symbol cooldown на обработку сигналов ликвидаций.
 *
 * DedupStore ловит только точные повторы (symbol + timestamp), а сканер lqmonitor_obi
 * выдаёт всплесками почти-дубли по одному символу за секунды — каждый со слегка иным
 * timestamp, поэтому dedup их не отсекает (реальные примеры: ROBOUSDT — 13 принятых
 * сигналов за ~90с, BEATUSDT ×3, TRUMPUSDT ×3 за 2с). Каждый такой сигнал запускает
 * полноценную задачу OBI-гейта и может выжрать все слоты maxPositionsPer10Min на одном
 * символе. Этот cooldown схлопывает всплеск: после первого принятого сигнала по символу
 * последующие по нему игнорируются в течение окна (default 90с).
 *
 * Состояние — только в памяти (как PositionRateLimiter). Потеря при рестарте допустима:
 * всплески длятся секунды.
 */
export class SymbolCooldown {
  private readonly windowMs: number;
  private readonly lastAccepted = new Map<string, number>();

  /** windowMs <= 0 полностью отключает cooldown. */
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** true — символ на кулдауне, сигнал надо отклонить. */
  isBlocked(symbol: string, now: number): boolean {
    if (this.windowMs <= 0) return false;
    const last = this.lastAccepted.get(symbol);
    if (last === undefined) return false;
    return now - last < this.windowMs;
  }

  /** Зафиксировать момент принятия сигнала по символу (запускает окно кулдауна). */
  record(symbol: string, now: number): void {
    this.lastAccepted.set(symbol, now);
  }
}
