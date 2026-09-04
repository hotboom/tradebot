/** Ограничивает число новых позиций в скользящем окне заданной длины (защита от лавины сигналов при обвале рынка).
 *  Длина окна настраивается: config.trading.maxPositionsWindowSec. */
export class PositionRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  canOpen(now: number): boolean {
    this.prune(now);
    return this.timestamps.length < this.limit;
  }

  recordOpen(now: number): void {
    this.prune(now);
    this.timestamps.push(now);
  }
}
