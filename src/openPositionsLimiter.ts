import type { BybitClient } from "./bybit/client";

/** Ограничивает число одновременно открытых позиций на аккаунте (config.trading.maxOpenPositions).
 *  Не добавляет задержки на входе: список открытых позиций опрашивается с Bybit в фоне
 *  (каждые refreshMs = maxPositionsWindowSec), а проверка сигнала — синхронная, по кэшу в памяти.
 *  Занятыми считаются символы: (1) с открытой позицией по последнему опросу, (2) по которым вход
 *  ещё исполняется (лимитный chase-вход может висеть секунды/минуты), (3) по которым вход только
 *  что завершился, но фоновый опрос, начатый после этого, ещё не прошёл — иначе между концом входа
 *  и следующим опросом слот выглядел бы свободным.
 *  Сигнал по символу, который уже занят, лимит не увеличивает и не блокируется. */
export class OpenPositionsLimiter {
  private openSymbols: Set<string> | null = null;
  private lastRefreshOkAt = 0;
  private readonly inFlight = new Map<string, number>();
  private readonly settling = new Map<string, number>();
  private refreshing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: BybitClient,
    private readonly limit: number,
    private readonly refreshMs: number,
    // Кэш считается протухшим, если подряд не прошли два фоновых опроса.
    private readonly maxStaleMs = refreshMs * 2 + 30000
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
    const startedAt = Date.now();
    try {
      const positions = await this.client.getOpenPositions();
      this.openSymbols = new Set(positions.map((p) => p.symbol));
      this.lastRefreshOkAt = Date.now();
      for (const [symbol, releasedAt] of this.settling) {
        if (releasedAt < startedAt) this.settling.delete(symbol);
      }
    } catch {
      // Оставляем прежний кэш; если опросы не проходят дольше maxStaleMs, tryReserve вернёт "stale".
    } finally {
      this.refreshing = false;
    }
  }

  /** "ok" — слот занят под symbol (вызывающий обязан потом вызвать release); "limit" — лимит
   *  достигнут; "stale" — нет свежих данных о позициях с Bybit, вход не открываем. */
  tryReserve(symbol: string, now = Date.now()): "ok" | "limit" | "stale" {
    if (this.openSymbols === null || now - this.lastRefreshOkAt > this.maxStaleMs) {
      return "stale";
    }
    const busy = new Set(this.openSymbols);
    for (const s of this.inFlight.keys()) busy.add(s);
    for (const s of this.settling.keys()) busy.add(s);
    if (!busy.has(symbol) && busy.size >= this.limit) {
      return "limit";
    }
    this.inFlight.set(symbol, (this.inFlight.get(symbol) ?? 0) + 1);
    return "ok";
  }

  release(symbol: string): void {
    const n = this.inFlight.get(symbol) ?? 0;
    if (n <= 1) this.inFlight.delete(symbol);
    else this.inFlight.set(symbol, n - 1);
    this.settling.set(symbol, Date.now());
  }
}
