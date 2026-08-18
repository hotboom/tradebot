/** Ограничивает число новых позиций в скользящем 10-минутном окне (защита от лавины сигналов при обвале рынка). */
export class PositionRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(limit: number, windowMs: number = 10 * 60 * 1000) {
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
