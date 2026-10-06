import type { AppConfig } from "./config";
import type { BybitClient, OpenPositionSummary, OpenStopOrder } from "./bybit/client";
import type { MarketTpSlConversionLogger } from "./logging/marketTpSlConversionLogger";
import type { MarketTpSlConversionLogEntry, OrderSide } from "./types";
import type { SymbolQueue } from "./util/symbolQueue";
import { SL_BACKUP_BUFFER_MULTIPLIER } from "./decision/exits";
import { replacePositionStop, stopLossOnValidSide } from "./decision/riskOrders";
import { placeablePrice, roundToTick } from "./util/rounding";

const LOG_TAG = "[market-tpsl]";

/** После неудачной попытки не повторяем её по символу чаще этого — иначе при стабильном отказе
 * биржи монитор долбил бы её на каждом тике. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

/** Full-режим ("TakeProfit"/"StopLoss" — так ставит приложение Bybit) и Partial-режим. */
const TP_STOP_ORDER_TYPES = new Set(["TakeProfit", "PartialTakeProfit"]);
const SL_STOP_ORDER_TYPES = new Set(["StopLoss", "PartialStopLoss"]);

/**
 * Переделывает маркетные TP + SL позиции в схему бота: лимитный TP + лимитный SL + независимый
 * резервный market-SL.
 *
 * Срабатывает, только если у позиции ровно два условных ордера — один МАРКЕТНЫЙ TP и один
 * МАРКЕТНЫЙ SL — и нет reduce-only лимитника (TP бота). Типичный случай — позиция, открытая
 * вручную в приложении Bybit с TP/SL (tpslMode "Full", оба Market). Любая другая комбинация
 * означает, что позицией уже управляет бот или там что-то нестандартное, — не трогаем.
 *
 * Цены сохраняются: лимитный TP — по триггеру старого TP, лимитный SL — по триггеру старого SL.
 * Резервный market-SL — дальше лимитного на ту же долю, что у входа/безубытка
 * (SL_BACKUP_BUFFER_MULTIPLIER от дистанции avgPrice→SL), но не меньше одного тика.
 *
 * Порядок безопасный: сначала SL через replacePositionStop (новый лимитный SL + backup встают ДО
 * снятия старого маркетного; при полном провале старый остаётся на месте), затем лимитный TP и
 * только после его подтверждения — снятие маркетного TP.
 *
 * Независим от PositionSizeSyncMonitor и breakeven/trailing: свой тумблер, интервал и лог. В
 * отличие от них НЕ останавливается при отсутствии позиций — ручная позиция может появиться в
 * любой момент без участия executor'а, и запускать монитор было бы некому. Доступ к ордерам
 * символа сериализуется через общий SymbolQueue.
 */
export class MarketTpSlConversionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Защита от наложения тиков, если один цикл проверки не успел завершиться до следующего.
  private ticking = false;
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly logger: MarketTpSlConversionLogger,
    private readonly symbolQueue: SymbolQueue
  ) {}

  /** Идемпотентно. Ничего не делает, если механизм выключен в настройках. */
  start(): void {
    if (this.timer || !this.config.trading.marketTpSlConversionEnabled) return;

    const intervalSec = this.config.trading.marketTpSlConversionCheckIntervalSec;
    console.log(`${LOG_TAG} monitor started (interval ${intervalSec}s)`);
    this.timer = setInterval(() => void this.tick(), intervalSec * 1000);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const positions = await this.client.getOpenPositions();
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
    const { symbol, side, size, avgPrice } = position;
    if (!Number.isFinite(size) || size <= 0 || !(avgPrice > 0)) return;

    const failedAt = this.failedAt.get(symbol);
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return;

    const [stopOrders, tpOrders] = await Promise.all([
      this.client.getOpenStopOrders(symbol),
      this.client.getOpenReduceOnlyLimitOrders(symbol),
    ]);
    if (tpOrders.length > 0 || stopOrders.length !== 2) return;
    const tpOrder = stopOrders.find((o) => TP_STOP_ORDER_TYPES.has(o.stopOrderType) && o.orderType === "Market");
    const slOrder = stopOrders.find((o) => SL_STOP_ORDER_TYPES.has(o.stopOrderType) && o.orderType === "Market");
    if (!tpOrder || !slOrder) return;

    const tp = tpOrder.triggerPrice;
    const sl = slOrder.triggerPrice;
    if (!(tp > 0) || !(sl > 0)) return;

    const [instrument, lastPrice] = await Promise.all([
      this.client.getInstrumentInfo(symbol),
      this.client.getLastPrice(symbol),
    ]);

    // Цена уже по ту сторону TP/SL (быстрый рынок, маркетный ордер вот-вот сработает сам) —
    // лимитный SL биржа отобьёт, а лимитный TP исполнится сразу по рынку. Ждём следующего тика.
    const tpOnValidSide = side === "Buy" ? tp > lastPrice : tp < lastPrice;
    if (!tpOnValidSide || !stopLossOnValidSide(side, sl, lastPrice)) {
      console.warn(`${LOG_TAG} ${symbol} TP ${tp} / SL ${sl} не с той стороны цены ${lastPrice}, пропускаем тик`);
      return;
    }

    // Резерв всегда дальше от цены, чем основной SL: для лонга ниже, для шорта выше.
    const backupOffset = Math.max(Math.abs(sl - avgPrice) * (SL_BACKUP_BUFFER_MULTIPLIER - 1), instrument.tickSize);
    const backupStopLoss = placeablePrice(
      roundToTick(side === "Buy" ? sl - backupOffset : sl + backupOffset, instrument.tickSize)
    );

    const base = { symbol, side, positionSize: size };

    // 1. SL: лимитный по тому же триггеру + резервный маркет; старый маркетный снимается после.
    let slResult: Awaited<ReturnType<typeof replacePositionStop>>;
    try {
      slResult = await replacePositionStop(this.client, {
        symbol,
        positionSide: side,
        size,
        stopLoss: sl,
        stopLossOrderType: "Limit",
        backupStopLoss,
        staleOrders: [slOrder],
      });
    } catch (err) {
      this.failedAt.set(symbol, Date.now());
      this.log(base, "SL", slOrder, sl, null, null, "failed", `${errorText(err)} — прежний маркетный SL сохранён`);
      console.error(`${LOG_TAG} ${symbol} failed to convert market SL (прежний SL сохранён):`, err);
      return;
    }
    const slNotes = [
      slResult.limitFallbackReason ? `limit SL rejected, fell back to market SL: ${slResult.limitFallbackReason}` : null,
      slResult.appliedSlOrderType === "Limit" && !slResult.backupPlaced
        ? `backup market SL not set: ${slResult.backupError ?? "invalid backup price"}`
        : null,
      slResult.cleanupError ? `old market SL cleanup failed: ${slResult.cleanupError}` : null,
    ].filter((n): n is string => n !== null);
    const placedBackup = slResult.backupPlaced ? backupStopLoss : null;
    this.log(
      base,
      "SL",
      slOrder,
      sl,
      slResult.appliedSlOrderType,
      placedBackup,
      "applied",
      slNotes.length > 0 ? slNotes.join("; ") : null
    );
    console.log(
      `${LOG_TAG} ${symbol} market SL -> ${slResult.appliedSlOrderType} SL ${sl}` +
        (placedBackup !== null ? ` + backup market SL ${placedBackup}` : "")
    );

    // 2. TP: лимитник по цене старого TP; старый маркетный снимаем только после того, как встал.
    const closingSide: OrderSide = side === "Buy" ? "Sell" : "Buy";
    try {
      await this.client.submitTakeProfitLimitOrder({ symbol, side: closingSide, qty: size, price: tp });
    } catch (err) {
      this.failedAt.set(symbol, Date.now());
      this.log(base, "TP", tpOrder, tp, null, null, "failed", `${errorText(err)} — прежний маркетный TP сохранён`);
      console.error(`${LOG_TAG} ${symbol} failed to place limit TP (прежний маркетный TP сохранён):`, err);
      return;
    }
    let tpCleanupError: string | null = null;
    try {
      await this.client.cancelRiskOrder({ symbol, orderId: tpOrder.orderId, stopOrderType: tpOrder.stopOrderType });
    } catch (err) {
      tpCleanupError = `old market TP cleanup failed: ${errorText(err)}`;
    }
    this.log(base, "TP", tpOrder, tp, null, null, "applied", tpCleanupError);
    console.log(`${LOG_TAG} ${symbol} market TP -> limit TP ${tp}${tpCleanupError ? ` (${tpCleanupError})` : ""}`);

    this.failedAt.delete(symbol);
  }

  private log(
    base: { symbol: string; side: OrderSide; positionSize: number },
    leg: MarketTpSlConversionLogEntry["leg"],
    oldOrder: OpenStopOrder,
    price: number,
    slOrderType: "Limit" | "Market" | null,
    backupStopLoss: number | null,
    status: MarketTpSlConversionLogEntry["status"],
    error: string | null
  ): void {
    this.logger.log({
      ...base,
      leg,
      oldOrderId: oldOrder.orderId,
      oldStopOrderType: oldOrder.stopOrderType,
      price,
      slOrderType,
      backupStopLoss,
      status,
      error,
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
