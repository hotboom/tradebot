import type { AppConfig } from "./config";
import type { BybitClient } from "./bybit/client";
import type { OrdersLogger } from "./logging/ordersLogger";
import type { CascadeSignal, OrderSide } from "./types";
import { resolveOrderSide } from "./decision/filters";
import { calcExitPrices } from "./decision/exits";
import { chaseLimitEntry } from "./bybit/limitChaseEntry";

// Резервный маркет-SL ставится дальше основного лимитного на этот множитель
// (при stopLossPercent=2% резервный триггер — на 2.2%).
const SL_BACKUP_BUFFER_MULTIPLIER = 1.1;

function roundDownToStep(value: number, step: number): number {
  const rounded = Math.floor(value / step) * step;
  // отбрасываем плавающий "хвост" вида 0.30000000000000004
  const decimals = (step.toString().split(".")[1] ?? "").length;
  return Number(rounded.toFixed(decimals));
}

function roundToTick(value: number, tick: number): number {
  const rounded = Math.round(value / tick) * tick;
  const decimals = (tick.toString().split(".")[1] ?? "").length;
  return Number(rounded.toFixed(decimals));
}

export class OrderExecutor {
  // Сериализация execute() по символу: не даём двум сигналам по одному символу выполняться
  // параллельно — иначе пересчёт SL/TP от средней цены/объёма позиции (см. run()) и
  // отмена/пересоздание backup-SL могут гоняться за неактуальным состоянием позиции.
  // Разные символы друг друга не блокируют (независимые записи в Map).
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly ordersLogger: OrdersLogger
  ) {}

  /** Исполнение принятого сигнала. Ошибки логируются, наружу не бросаются. */
  execute(signal: CascadeSignal): Promise<void> {
    const prev = this.queues.get(signal.symbol) ?? Promise.resolve();
    const next = prev.then(() => this.run(signal)).catch(() => {});
    this.queues.set(signal.symbol, next);
    return next;
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

    // Шаг 2 (вне критического пути): выставляем SL/TP на открытую позицию отдельным запросом.
    if (sl !== null || tp !== null) {
      const preferLimitSl = sl !== null && this.config.trading.stopLossOrderType === "limit";
      let appliedSlOrderType: "Market" | "Limit" | null = sl !== null ? (preferLimitSl ? "Limit" : "Market") : null;

      // Все старые условные ордера риск-менеджмента этой позиции (Partial SL/TP от
      // setTradingStop + независимый backup-SL) чистим безусловно перед пересозданием —
      // setTradingStop в tpslMode: "Partial" не заменяет предыдущие partial-ордера при
      // повторном вызове, а добавляет новые поверх (подтверждено на боевом аккаунте) — без
      // явной отмены на бирже копятся дублирующиеся SL/TP с устаревшими qty/ценой.
      let cleanupError: string | null = null;
      try {
        const staleOrderIds = await this.client.getOpenStopOrders(signal.symbol);
        for (const staleOrderId of staleOrderIds) {
          await this.client.cancelOrder({ symbol: signal.symbol, orderId: staleOrderId });
        }
      } catch (err) {
        cleanupError = err instanceof Error ? err.message : String(err);
      }

      try {
        await this.client.setTradingStop({
          symbol: signal.symbol,
          qty: positionQty as number,
          stopLoss: sl,
          stopLossOrderType: appliedSlOrderType ?? "Market",
          takeProfit: tp,
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
              takeProfit: tp,
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
              error: `SL/TP not set (limit SL failed: ${err instanceof Error ? err.message : String(err)}; market SL fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)})`,
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
            error: `SL/TP not set: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }

      // Резервный маркет-SL ставим только если основной действительно встал как Limit — если
      // он уже упал на Market, страховка избыточна: Market и так закрывает позицию немедленно
      // по срабатыванию (старые condition-ордера, включая прошлый backup, уже подчищены выше).
      let backupPlaced = false;
      let backupOrderError: string | null = null;
      if (appliedSlOrderType === "Limit" && slBackup !== null) {
        const closingSide: OrderSide = side === "Buy" ? "Sell" : "Buy";
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

      const notes = [
        preferLimitSl && appliedSlOrderType === "Market" ? "limit SL rejected, fell back to market SL" : null,
        cleanupError ? `stale SL/TP cleanup failed: ${cleanupError}` : null,
        appliedSlOrderType === "Limit" && slBackup !== null && !backupPlaced
          ? `backup market SL not set: ${backupOrderError}`
          : null,
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
