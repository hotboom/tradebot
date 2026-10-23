import type { BybitClient } from "./bybit/client";

const REFRESH_MS = 60_000;

/** Отсекает сигналы по монетам, у которых |изменение цены за 24ч| > maxPercent
 *  (config.trading.max24hChangePercent). Не добавляет задержки на входе: изменение за 24ч по всем
 *  linear-тикерам берётся с Bybit одним запросом в фоне раз в минуту, проверка — по кэшу.
 *  Символ, которого нет в кэше (например, свежий листинг между опросами), пропускается. */
export class PriceChangeFilter {
  private changes: Map<string, number> | null = null;
  private lastRefreshOkAt = 0;
  private refreshing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: BybitClient,
    private readonly maxPercent: number,
    private readonly refreshMs = REFRESH_MS,
    // Кэш считается протухшим, если подряд не прошли несколько фоновых опросов.
    private readonly maxStaleMs = refreshMs * 3 + 30000
  ) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.changes = await this.client.getAll24hChangePercent();
      this.lastRefreshOkAt = Date.now();
    } catch (err) {
      // Оставляем прежний кэш; если опросы не проходят дольше maxStaleMs, check вернёт "stale".
      console.error("[priceChangeFilter] tickers refresh failed:", err instanceof Error ? err.message : err);
    } finally {
      this.refreshing = false;
    }
  }

  /** "ok" — можно входить; "filtered" — монета за 24ч изменилась больше maxPercent;
   *  "stale" — нет свежих данных с Bybit, вход не открываем. */
  check(symbol: string, now = Date.now()): "ok" | "filtered" | "stale" {
    if (this.changes === null || now - this.lastRefreshOkAt > this.maxStaleMs) {
      return "stale";
    }
    const pct = this.changes.get(symbol);
    if (pct !== undefined && Math.abs(pct) > this.maxPercent) {
      return "filtered";
    }
    return "ok";
  }
}
