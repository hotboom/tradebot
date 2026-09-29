import type { AppConfig } from "./config";
import type { BybitClient, OpenPositionSummary } from "./bybit/client";
import type { PositionSyncLogger } from "./logging/positionSyncLogger";
import type { PositionSyncOrderKind } from "./types";
import type { SymbolQueue } from "./util/symbolQueue";

const LOG_TAG = "[position-sync]";

/**
 * Периодически проверяет все открытые позиции и УМЕНЬШАЕТ объём TP-лимитника и обоих SL
 * (основной PartialStopLoss + независимый резервный Stop) до фактического размера позиции,
 * если он оказался ей больше, — НЕ трогая их цену/триггер. Нужен на случай ручного частичного
 * закрытия позиции в приложении/на бирже: лимитные TP и оба SL остаются выставлены на старый
 * (больший) объём, пока их никто не поправит, и при срабатывании попытаются закрыть больше,
 * чем осталось от позиции.
 *
 * Важно: только УМЕНЬШАЕТ, никогда не увеличивает. Если объём ордера МЕНЬШЕ позиции, монитор
 * его не трогает — это либо ордер, ещё не подтянутый под подросшую позицию (её досайзит сам
 * executor.ts при повторном входе, не этот монитор), либо, что важнее, ордер, который сам
 * пользователь намеренно выставил меньше позиции — например, отдельный reduce-only лимитник
 * на частичное закрытие вручную. Раньше монитор сверял объём в обе стороны и такой ручной
 * частичный клоуз тут же «чинил» обратно до полного объёма позиции — превращая частичное
 * закрытие в полное. Несимметричность правила (только вниз) устраняет это, не жертвуя
 * основным сценарием: пересинхронизацией TP/SL после того, как позиция стала МЕНЬШЕ.
 *
 * В отличие от breakeven/trailing (которые пересчитывают ЦЕНУ и потому вынуждены снимать
 * старый условный ордер и ставить новый, см. replacePositionStop), здесь меняется только
 * объём уже существующего ордера — это делается одним amendOrder(qty) по его orderId, без
 * cancel+place и, следовательно, без риска временно остаться без защиты.
 *
 * Работает как таймер, а не постоянный цикл, и, в отличие от breakeven/trailing, не имеет
 * отдельного enable-тумблера в настройках — это не опциональная стратегия выхода, а
 * поддержание корректности уже выставленных ордеров, поэтому включён всегда, пока бот
 * работает. start() идемпотентен, вызывается на старте процесса и после каждого открытия
 * позиции (см. server.ts/executor.ts). Если к моменту тика открытых позиций нет, тик сам
 * себя останавливает (clearInterval) до следующего входа.
 *
 * Как и breakeven/trailing, сериализует доступ к условным ордерам позиции по символу через
 * общий SymbolQueue — не даёт гоняться за неактуальным состоянием биржи параллельно с
 * executor.ts/другими мониторами.
 */
export class PositionSizeSyncMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Защита от наложения тиков, если один цикл проверки не успел завершиться до следующего.
  private ticking = false;

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly logger: PositionSyncLogger,
    private readonly symbolQueue: SymbolQueue
  ) {}

  /** Идемпотентно: повторный вызов при уже запущенном таймере ничего не делает. */
  start(): void {
    if (this.timer) return;

    const intervalMs = this.config.trading.positionSyncCheckIntervalSec * 1000;
    console.log(`${LOG_TAG} monitor started (interval ${this.config.trading.positionSyncCheckIntervalSec}s)`);
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log(`${LOG_TAG} no open positions, monitor stopped until next entry`);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const positions = await this.client.getOpenPositions();
      if (positions.length === 0) {
        this.stop();
        return;
      }
      for (const position of positions) {
        try {
          await this.symbolQueue.run(position.symbol, () => this.checkPosition(position));
        } catch (err) {
          console.error(`${LOG_TAG} check failed for ${position.symbol}:`, err);
        }
      }
    } catch (err) {
      console.error(`${LOG_TAG} failed to fetch open positions:`, err);
    } finally {
      this.ticking = false;
    }
  }

  private async checkPosition(position: OpenPositionSummary): Promise<void> {
    const { symbol, side, size } = position;
    if (!Number.isFinite(size) || size <= 0) return;

    const [instrument, stopOrders, tpOrders] = await Promise.all([
      this.client.getInstrumentInfo(symbol),
      this.client.getOpenStopOrders(symbol),
      this.client.getOpenReduceOnlyLimitOrders(symbol),
    ]);

    // Объём позиции меньше минимального лота биржи (например, «хвост» после частичного
    // закрытия) — амендить условные ордера на такой объём биржа всё равно отклонит, оставляем
    // как есть и ждём следующего тика/ручного вмешательства.
    if (size < instrument.minOrderQty) return;

    // Только вниз: амендим, если ордер БОЛЬШЕ позиции (допуск в половину шага объёма гасит
    // плавающий float-шум). Ордер меньше позиции — не трогаем (см. комментарий класса: это
    // может быть намеренный ручной частичный клоуз, не наша забота его увеличивать).
    const tolerance = instrument.qtyStep / 2;
    const isOversized = (orderQty: number): boolean => orderQty - size > tolerance;

    const tasks: Array<{ kind: PositionSyncOrderKind; orderId: string; previousQty: number }> = [];

    // TP — обычный reduce-only лимитник (submitTakeProfitLimitOrder). Обычно один на символ, но
    // на всякий случай синхронизируем все найденные.
    for (const order of tpOrders) {
      if (isOversized(order.qty)) {
        tasks.push({ kind: "TP", orderId: order.orderId, previousQty: order.qty });
      }
    }

    // Оба SL позиции: основной (PartialStopLoss от setTradingStop) и независимый резервный
    // (Stop от submitStopMarketOrder). Легаси PartialTakeProfit не трогаем — TP теперь отдельный
    // лимитник (см. riskOrders.ts).
    for (const order of stopOrders) {
      if (order.stopOrderType === "PartialTakeProfit") continue;
      if (!isOversized(order.qty)) continue;
      const kind: PositionSyncOrderKind = order.stopOrderType === "PartialStopLoss" ? "SL" : "SL_BACKUP";
      tasks.push({ kind, orderId: order.orderId, previousQty: order.qty });
    }

    for (const task of tasks) {
      try {
        const result = await this.client.amendOrderQty({ symbol, orderId: task.orderId, qty: size });
        if (result === "gone") continue; // ордер уже пропал между чтением списка и амендом — не ошибка
        this.logger.log({
          symbol,
          side,
          positionSize: size,
          orderKind: task.kind,
          orderId: task.orderId,
          previousQty: task.previousQty,
          newQty: size,
          status: "applied",
          error: null,
        });
        console.log(`${LOG_TAG} ${symbol} ${task.kind} qty ${task.previousQty} -> ${size}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.log({
          symbol,
          side,
          positionSize: size,
          orderKind: task.kind,
          orderId: task.orderId,
          previousQty: task.previousQty,
          newQty: size,
          status: "failed",
          error,
        });
        console.error(`${LOG_TAG} ${symbol} failed to amend ${task.kind} qty:`, err);
      }
    }
  }
}
