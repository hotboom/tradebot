import type { AppConfig } from "./config";
import type { BybitClient } from "./bybit/client";
import type { OrdersLogger } from "./logging/ordersLogger";
import type { CascadeSignal, OrderSide } from "./types";
import { resolveOrderSide } from "./decision/filters";
import { calcExitPrices, SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
import { replacePositionStop } from "./decision/riskOrders";
import { chaseLimitEntry } from "./bybit/limitChaseEntry";
import { roundDownToStep, roundToTick, placeablePrice } from "./util/rounding";
import type { BreakevenMonitor } from "./breakevenMonitor";
import type { TrailingStopMonitor } from "./trailingStopMonitor";
import type { SymbolQueue } from "./util/symbolQueue";

export class OrderExecutor {
  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly ordersLogger: OrdersLogger,
    private readonly breakevenMonitor: BreakevenMonitor,
    private readonly trailingStopMonitor: TrailingStopMonitor,
    // Сериализация по символу (общая с BreakevenMonitor/TrailingStopMonitor): не даём двум
    // сигналам по одному символу, либо сигналу и тику монитора, выполняться параллельно —
    // иначе пересчёт SL/TP от средней цены/объёма позиции (см. run()) и отмена/пересоздание
    // условных ордеров могут гоняться за неактуальным состоянием позиции. Разные символы друг
    // друга не блокируют.
    private readonly symbolQueue: SymbolQueue
  ) {}

  /** Исполнение принятого сигнала. Ошибки логируются, наружу не бросаются. */
  execute(signal: CascadeSignal): Promise<void> {
    return this.symbolQueue.run(signal.symbol, () => this.run(signal)).catch(() => {});
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
      sl = placeablePrice(exits.stopLoss !== null ? roundToTick(exits.stopLoss, instrument.tickSize) : null);
      tp = placeablePrice(exits.takeProfit !== null ? roundToTick(exits.takeProfit, instrument.tickSize) : null);
      // exits вернул цену, а после округления она невалидна (0/NaN — например из-за кривого
      // tickSize у низкоценовой монеты): на биржу нулём НЕ шлём (Bybit воспримет 0 как снятие
      // стопа), фиксируем как ошибку в orders.log.
      const riskPriceError =
        (exits.stopLoss !== null && sl === null) || (exits.takeProfit !== null && tp === null)
          ? `${[exits.stopLoss !== null && sl === null ? "SL" : null, exits.takeProfit !== null && tp === null ? "TP" : null]
              .filter((x): x is string => x !== null)
              .join("+")} не выставлен: некорректная цена после округления (tickSize ${instrument.tickSize})`
          : null;

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
        error: riskPriceError,
      });
      if (riskPriceError) {
        console.error(`[executor] ${signal.symbol} ${riskPriceError}`);
      }
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
      // пересоздаём под новый объём позиции). Условные ордера, если ставим новый SL, снимаем
      // не здесь, а внутри replacePositionStop — уже ПОСЛЕ того, как новый SL подтверждён
      // (place-before-cancel, см. инцидент BNCUSDT 2026-09-08).
      let cleanupError: string | null = null;
      const noteCleanupError = (err: unknown): void => {
        const msg = err instanceof Error ? err.message : String(err);
        cleanupError = cleanupError ? `${cleanupError}; ${msg}` : msg;
      };
      let staleStopOrders: Awaited<ReturnType<typeof this.client.getOpenStopOrders>> = [];
      try {
        staleStopOrders = await this.client.getOpenStopOrders(signal.symbol);
        if (sl === null) {
          // SL не ставим (выключен в конфиге) — старые условные ордера всё равно снимаем сразу.
          for (const staleOrder of staleStopOrders) {
            await this.client.cancelOrder({ symbol: signal.symbol, orderId: staleOrder.orderId });
          }
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

      // SL на позицию (place-before-cancel: новый SL + backup ставятся до отмены старых
      // условных ордеров, старые снимаются только после подтверждения нового — при полном
      // провале старый SL остаётся на месте).
      let backupPlaced = false;
      let backupOrderError: string | null = null;
      if (sl !== null) {
        try {
          const result = await replacePositionStop(this.client, {
            symbol: signal.symbol,
            positionSide: side,
            size: positionQty as number,
            stopLoss: sl,
            stopLossOrderType: preferLimitSl ? "Limit" : "Market",
            backupStopLoss: preferLimitSl ? slBackup : null,
            staleOrders: staleStopOrders,
          });
          appliedSlOrderType = result.appliedSlOrderType;
          backupPlaced = result.backupPlaced;
          backupOrderError = result.backupError;
          if (result.cleanupError) noteCleanupError(result.cleanupError);
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
            bybitOrderId: orderId,
            error: `SL not set: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
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
