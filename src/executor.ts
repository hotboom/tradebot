import type { AppConfig } from "./config";
import type { BybitClient } from "./bybit/client";
import type { OrdersLogger } from "./logging/ordersLogger";
import type { ObiLogger } from "./logging/obiLogger";
import type { CascadeSignal, OrderSide } from "./types";
import { resolveOrderSide } from "./decision/filters";
import { calcExitPrices, SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
import { chaseLimitEntry } from "./bybit/limitChaseEntry";
import { waitForObiReversal, trackObiAfterOutcome } from "./obi/obiEntryGate";
import { roundDownToStep, roundToTick } from "./util/rounding";
import type { BreakevenMonitor } from "./breakevenMonitor";
import type { TrailingStopMonitor } from "./trailingStopMonitor";
import type { SymbolQueue } from "./util/symbolQueue";
import type { PositionRateLimiter } from "./positionRateLimiter";

export class OrderExecutor {
  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly ordersLogger: OrdersLogger,
    private readonly obiLogger: ObiLogger,
    private readonly breakevenMonitor: BreakevenMonitor,
    private readonly trailingStopMonitor: TrailingStopMonitor,
    // Сериализация по символу (общая с BreakevenMonitor/TrailingStopMonitor): не даём двум
    // сигналам по одному символу, либо сигналу и тику монитора, выполняться параллельно —
    // иначе пересчёт SL/TP от средней цены/объёма позиции (см. run()) и отмена/пересоздание
    // условных ордеров могут гоняться за неактуальным состоянием позиции. Разные символы друг
    // друга не блокируют.
    private readonly symbolQueue: SymbolQueue,
    // Часовой лимит новых позиций считается по фактическим входам, а не по принятым сигналам —
    // recordOpen() вызывается только после того, как OBI-гейт (см. ниже) подтвердил разворот и
    // вход действительно произойдёт, а не на каждую попытку (большая часть которых по счётчику
    // может быть отменена гейтом и не открыть ни одной позиции).
    private readonly positionLimiter: PositionRateLimiter
  ) {}

  /** Исполнение принятого сигнала. Сначала ждёт разворота OBI (см. obi/obiEntryGate.ts) — вход
   * не по самому дисбалансу книги в сторону сигнала, а по его развороту к нейтральному/
   * противоположному значению в течение `trading.obi.windowSec` секунд после сигнала. Если
   * разворот не произошёл вовремя — попытка входа отменяется целиком (ордер не выставляется).
   * Ошибки логируются, наружу не бросаются. */
  async execute(signal: CascadeSignal): Promise<void> {
    try {
      if (!this.config.trading.obi.enabled) {
        // OBI-гейт выключен в настройках — прежнее поведение tradebot2: вход сразу по сигналу.
        if (!this.positionLimiter.canOpen(Date.now())) {
          this.logCancelled(signal, "hourly_limit_at_trigger");
          return;
        }
        this.positionLimiter.recordOpen(Date.now());
        await this.symbolQueue.run(signal.symbol, () => this.run(signal));
        return;
      }

      // Ожидание разворота выполняется вне symbolQueue: это чтение публичного стакана, оно не
      // трогает условные ордера позиции и не должно блокировать другие символы или блокироваться
      // тиками breakeven/trailing-мониторов по этому же символу.
      const gate = await waitForObiReversal(this.client, this.obiLogger, signal, this.config.trading.obi);

      // Пост-трекинг цены/OBI ещё ~2 мин после исхода — и после входа, и после отмены — для
      // разбора качества фильтра постфактум (см. trackObiAfterOutcome). Detached: не блокирует
      // вход и обработку других сигналов, наружу не бросает.
      void trackObiAfterOutcome(
        this.client,
        this.obiLogger,
        signal,
        gate.triggered ? "triggered" : "timeout",
        gate.triggered ? true : gate.extremeSeen,
        gate.mid
      ).catch(() => undefined);

      if (!gate.triggered) {
        this.logCancelled(
          signal,
          `obi_reversal_timeout: no reversal within ${this.config.trading.obi.windowSec}s ` +
            `(extreme seen: ${gate.extremeSeen}, last obi: ${gate.lastObi ?? "n/a"})`
        );
        return;
      }

      // Разворот подтверждён — перепроверяем часовой лимит прямо перед входом (мог исчерпаться,
      // пока этот сигнал ждал разворота) и учитываем открытие только сейчас.
      if (!this.positionLimiter.canOpen(Date.now())) {
        this.logCancelled(signal, "hourly_limit_at_trigger");
        return;
      }
      this.positionLimiter.recordOpen(Date.now());

      await this.symbolQueue.run(signal.symbol, () => this.run(signal));
    } catch {
      // не даём ошибке гейта/входа всплыть наружу — сервер уже ответил на HTTP-запрос сигнала
    }
  }

  private logCancelled(signal: CascadeSignal, reason: string): void {
    this.ordersLogger.log({
      symbol: signal.symbol,
      side: resolveOrderSide(signal.direction),
      qty: null,
      entryPriceRef: signal.lastBankruptcyPrice,
      refMarketPrice: null,
      sl: null,
      slOrderType: null,
      slBackupPrice: null,
      tp: null,
      status: "cancelled",
      bybitOrderId: null,
      error: reason,
    });
  }

  private async run(signal: CascadeSignal): Promise<void> {
    const side: OrderSide = resolveOrderSide(signal.direction);
    // Цену входа не запрашиваем отдельно (getLastPrice убран из критического пути):
    // qty и SL/TP считаем от lastBankruptcyPrice из сигнала (MVP, проскальзывание допустимо).
    const entryPriceRef = signal.lastBankruptcyPrice;
    let qty: number | null = null;
    // Полный текущий объём позиции (может быть больше qty при повторном входе по символу) —
    // от него сайзим SL/TP, чтобы защищать всю позицию, а не только последний вход.
    let positionQty: number | null = null;
    let sl: number | null = null;
    let slBackup: number | null = null;
    let tp: number | null = null;
    let orderId: string | null = null;
    let refMarketPrice: number | null = null;

    // Шаг 1: вход без SL/TP (маркет — быстрый путь по умолчанию, либо чейз лимитником — см. entryOrderType).
    try {
      const instrument = await this.client.getInstrumentInfo(signal.symbol);

      const rawQty = this.config.trading.positionSizeUsdt / entryPriceRef;
      qty = roundDownToStep(rawQty, instrument.qtyStep);
      if (qty < instrument.minOrderQty) {
        qty = instrument.minOrderQty;
      }
      positionQty = qty;

      let fillPrice = entryPriceRef;
      if (this.config.trading.entryOrderType === "limit") {
        // Чейзит лимитник на best bid/ask до полного исполнения (без таймаута — см. план).
        const chase = await chaseLimitEntry(this.client, { symbol: signal.symbol, side, qty });
        orderId = chase.lastOrderId;
        fillPrice = chase.avgPrice;
        refMarketPrice = chase.refPrice;
      } else {
        orderId = await this.client.submitMarketOrder({
          symbol: signal.symbol,
          side,
          qty,
        });
      }

      // Реальные среднюю цену и полный объём входа берём из позиции (а не из fillPrice/qty
      // этого конкретного входа) — при повторном входе по символу Bybit уже отразит в позиции
      // блендед avgPrice и суммарный size по всем входам. Если позиция ещё не отразилась —
      // откатываемся на цену/объём только этого входа (fillPrice/qty уже посчитаны выше).
      try {
        const position = await this.client.getOpenPosition(signal.symbol);
        if (position) {
          fillPrice = position.avgPrice;
          positionQty = position.size;
        }
      } catch {
        // позиция недоступна — считаем SL/TP от цены/объёма только этого входа
      }

      // Позиция на бирже уже открыта (независимо от того, встанет ли ниже SL/TP) — запускаем
      // (если ещё не запущены) периодический перенос стопа в безубыток и trailing-stop. Оба
      // монитора идемпотентны и не делают ничего, если выключены в настройках.
      this.breakevenMonitor.start();
      this.trailingStopMonitor.start();

      // SL/TP считаем после входа от фактической цены исполнения — не задерживает вход.
      const exits = calcExitPrices(
        side,
        fillPrice,
        this.config.trading.stopLossPercent,
        this.config.trading.takeProfitPercent
      );
      sl = exits.stopLoss !== null ? roundToTick(exits.stopLoss, instrument.tickSize) : null;
      tp = exits.takeProfit !== null ? roundToTick(exits.takeProfit, instrument.tickSize) : null;

      // Резервный маркет-SL считаем заранее (нужен только если основной SL — лимитный).
      if (sl !== null && this.config.trading.stopLossOrderType === "limit" && this.config.trading.stopLossPercent !== null) {
        const backupExits = calcExitPrices(
          side,
          fillPrice,
          this.config.trading.stopLossPercent * SL_BACKUP_BUFFER_MULTIPLIER,
          null
        );
        slBackup = backupExits.stopLoss !== null ? roundToTick(backupExits.stopLoss, instrument.tickSize) : null;
      }

      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef: fillPrice,
        refMarketPrice,
        sl,
        slOrderType: null,
        slBackupPrice: null,
        tp,
        status: "filled",
        bybitOrderId: orderId,
        error: null,
      });
    } catch (err) {
      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef,
        refMarketPrice,
        sl,
        slOrderType: null,
        slBackupPrice: null,
        tp,
        status: "failed",
        bybitOrderId: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Шаг 2 (вне критического пути): SL ставим на позицию через setTradingStop, TP — отдельным
    // reduce-only лимитным ордером (один ценник, виден в стакане, свободно двигается вручную в
    // приложении/на графике, в отличие от TP через setTradingStop с парой trigger/limit).
    if (sl !== null || tp !== null) {
      const closingSide: OrderSide = side === "Buy" ? "Sell" : "Buy";
      const preferLimitSl = sl !== null && this.config.trading.stopLossOrderType === "limit";
      let appliedSlOrderType: "Market" | "Limit" | null = sl !== null ? (preferLimitSl ? "Limit" : "Market") : null;

      // Старые ордера риск-менеджмента этой позиции чистим перед пересозданием (актуально при
      // повторном входе по символу): условные (Partial SL от setTradingStop + независимый
      // backup-SL — setTradingStop в tpslMode "Partial" не заменяет предыдущие partial-ордера,
      // а добавляет новые поверх) и обычный reduce-only лимитный TP (его размер/цену
      // пересоздаём под новый объём позиции).
      let cleanupError: string | null = null;
      const noteCleanupError = (err: unknown): void => {
        const msg = err instanceof Error ? err.message : String(err);
        cleanupError = cleanupError ? `${cleanupError}; ${msg}` : msg;
      };
      try {
        const staleOrders = await this.client.getOpenStopOrders(signal.symbol);
        for (const staleOrder of staleOrders) {
          await this.client.cancelOrder({ symbol: signal.symbol, orderId: staleOrder.orderId });
        }
      } catch (err) {
        noteCleanupError(err);
      }
      try {
        const staleTpOrders = await this.client.getOpenReduceOnlyLimitOrders(signal.symbol);
        for (const staleTp of staleTpOrders) {
          await this.client.cancelOrder({ symbol: signal.symbol, orderId: staleTp.orderId });
        }
      } catch (err) {
        noteCleanupError(err);
      }

      // SL на позицию.
      if (sl !== null) {
        try {
          await this.client.setTradingStop({
            symbol: signal.symbol,
            qty: positionQty as number,
            stopLoss: sl,
            stopLossOrderType: appliedSlOrderType ?? "Market",
          });
        } catch (err) {
          // Лимитный SL не встал (например, недостаточно ликвидности по цене) — пробуем
          // обычный маркет SL, чтобы не остаться без защиты позиции.
          if (preferLimitSl) {
            appliedSlOrderType = "Market";
            try {
              await this.client.setTradingStop({
                symbol: signal.symbol,
                qty: positionQty as number,
                stopLoss: sl,
                stopLossOrderType: "Market",
              });
            } catch (fallbackErr) {
              this.ordersLogger.log({
                symbol: signal.symbol,
                side,
                qty,
                entryPriceRef,
                refMarketPrice,
                sl,
                slOrderType: null,
                slBackupPrice: null,
                tp,
                status: "failed",
                bybitOrderId: orderId,
                error: `SL not set (limit SL failed: ${err instanceof Error ? err.message : String(err)}; market SL fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)})`,
              });
              return;
            }
          } else {
            this.ordersLogger.log({
              symbol: signal.symbol,
              side,
              qty,
              entryPriceRef,
              refMarketPrice,
              sl,
              slOrderType: null,
              slBackupPrice: null,
              tp,
              status: "failed",
              bybitOrderId: orderId,
              error: `SL not set: ${err instanceof Error ? err.message : String(err)}`,
            });
            return;
          }
        }
      }

      // Резервный маркет-SL ставим только если основной действительно встал как Limit — если
      // он уже упал на Market, страховка избыточна: Market и так закрывает позицию немедленно
      // по срабатыванию (старые condition-ордера, включая прошлый backup, уже подчищены выше).
      let backupPlaced = false;
      let backupOrderError: string | null = null;
      if (appliedSlOrderType === "Limit" && slBackup !== null) {
        const triggerDirection: 1 | 2 = side === "Buy" ? 2 : 1;
        try {
          await this.client.submitStopMarketOrder({
            symbol: signal.symbol,
            side: closingSide,
            qty: positionQty as number,
            triggerPrice: slBackup,
            triggerDirection,
          });
          backupPlaced = true;
        } catch (err) {
          backupOrderError = err instanceof Error ? err.message : String(err);
        }
      }

      // TP — отдельным reduce-only лимитником на весь текущий объём позиции.
      let tpPlaced = false;
      let tpOrderError: string | null = null;
      if (tp !== null) {
        try {
          await this.client.submitTakeProfitLimitOrder({
            symbol: signal.symbol,
            side: closingSide,
            qty: positionQty as number,
            price: tp,
          });
          tpPlaced = true;
        } catch (err) {
          tpOrderError = err instanceof Error ? err.message : String(err);
        }
      }

      const notes = [
        preferLimitSl && appliedSlOrderType === "Market" ? "limit SL rejected, fell back to market SL" : null,
        cleanupError ? `stale order cleanup failed: ${cleanupError}` : null,
        appliedSlOrderType === "Limit" && slBackup !== null && !backupPlaced
          ? `backup market SL not set: ${backupOrderError}`
          : null,
        tp !== null && !tpPlaced ? `TP limit order not set: ${tpOrderError}` : null,
      ].filter((note): note is string => note !== null);

      this.ordersLogger.log({
        symbol: signal.symbol,
        side,
        qty,
        entryPriceRef,
        refMarketPrice,
        sl,
        slOrderType: appliedSlOrderType,
        slBackupPrice: appliedSlOrderType === "Limit" && backupPlaced ? slBackup : null,
        tp,
        status: "filled",
        bybitOrderId: orderId,
        error: notes.length > 0 ? notes.join("; ") : null,
      });
    }
  }
}
