import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import type { CascadeSignal, OrderSide } from "../types";
import type { BybitClient, OrderState } from "./client";
import type { SymbolQueue } from "../util/symbolQueue";
import type { OrdersLogger } from "../logging/ordersLogger";
import { roundDownToStep, roundToTick, placeablePrice } from "../util/rounding";
import { resolveOrderSide } from "../decision/filters";
import { calcExitPrices } from "../decision/exits";

export function entryDistancePercent(previous: number, candidate: number, side: OrderSide): number {
  if (!(previous > 0) || !Number.isFinite(previous) || !(candidate > 0) || !Number.isFinite(candidate)) {
    throw new Error("Invalid entry distance prices");
  }
  return (side === "Buy" ? (previous - candidate) : (candidate - previous)) / previous * 100;
}

export function meetsEntryDistance(previous: number, candidate: number, side: OrderSide, percent: number): boolean {
  return entryDistancePercent(previous, candidate, side) + 1e-10 >= percent;
}

class EntryDistanceRejection extends Error {
  constructor(readonly price: number, readonly last: number, readonly previous: number | null,
    readonly minimum: number, readonly distance: number | null) {
    super(previous === null
      ? "entry_reference_missing: open position has no known last executed entry; add-on skipped"
      : `min_entry_distance: candidate ${price}, previous fill ${previous}, distance ${distance}%, required ${minimum}%`);
  }
}

export interface OffsetEntry {
  signal: CascadeSignal;
  side: OrderSide;
  qty: number;
  refPrice: number;
  price: number;
  offsetPercent: number;
  minEntryDistancePercent?: number;
  previousEntryPrice?: number | null;
  actualEntryDistancePercent?: number | null;
  orderLinkId: string;
  orderId: string | null;
}
export interface OffsetFill {
  entry: OffsetEntry;
  qty: number;
  avgPrice: number;
  filledAt: number;
  outcome: string;
}

export function offsetPrice(last: number, side: OrderSide, percent: number, tick: number): number {
  if (!(last > 0) || !Number.isFinite(last) || !(percent > 0 && percent < 100) || !(tick > 0)) {
    throw new Error("Invalid offset limit price parameters");
  }
  const raw = last * (side === "Buy" ? 1 - percent / 100 : 1 + percent / 100);
  const price = side === "Buy" ? roundDownToStep(raw, tick) : -roundDownToStep(-raw, tick);
  if (placeablePrice(price) === null) throw new Error("Invalid rounded offset limit price");
  return price;
}

/** Fixed PostOnly order. Waiting never holds symbolQueue. State is saved BEFORE submission;
 * ambiguous submit responses are reconciled by orderLinkId, never blindly re-submitted. */
export class OffsetLimitEntries {
  private readonly entries = new Map<string, OffsetEntry>();
  private readonly busy = new Set<string>();
  private readonly finalizedIds = new Set<string>();
  private readonly lastFills = new Map<string, { side: OrderSide; price: number; ts: number }>();
  private readonly statePath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly client: BybitClient,
    private readonly queue: SymbolQueue,
    private readonly logger: OrdersLogger,
    private readonly onFill: (fill: OffsetFill) => Promise<void>,
  ) {
    this.statePath = path.join(path.dirname(path.resolve(config.logging.ordersLogPath)), "offset-entries.json");
    const logPath = path.resolve(config.logging.ordersLogPath);
    if (fs.existsSync(logPath)) {
      for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row.status === "filled" && Number.isFinite(row.orderFillPrice) && row.orderFillPrice > 0
            && (row.side === "Buy" || row.side === "Sell") && typeof row.symbol === "string") {
            const ts = row.entryFilledAt ?? row.ts;
            if (ts >= (this.lastFills.get(`${row.symbol}:${row.side}`)?.ts ?? 0)) {
              this.lastFills.set(`${row.symbol}:${row.side}`, { side: row.side, price: row.orderFillPrice, ts });
            }
          }
          if (row.entryOrderType === "offset_limit" && row.status === "filled" && row.bybitOrderId) {
            this.finalizedIds.add(row.bybitOrderId);
          }
        } catch { /* An incomplete last JSONL line must not discard pending exchange orders. */ }
      }
    }
    if (fs.existsSync(this.statePath)) {
      const saved: OffsetEntry[] = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!Array.isArray(saved)) throw new Error("Invalid offset entry state");
      for (const entry of saved) {
        if (!entry.signal?.symbol || !entry.orderLinkId || !(entry.price > 0) || !(entry.qty > 0)) {
          throw new Error("Invalid saved offset entry; refusing to lose track of orders");
        }
        if (this.entries.has(entry.signal.symbol)) throw new Error("Duplicate saved offset entry symbol");
        this.entries.set(entry.signal.symbol, entry);
        this.busy.add(entry.signal.symbol);
      }
    }
  }

  hasPending(symbol: string): boolean { return this.busy.has(symbol); }
  pendingSymbols(): string[] { return [...this.busy]; }

  private save(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify([...this.entries.values()], null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.statePath);
  }

  private log(entry: OffsetEntry, status: "submitted" | "cancelled" | "failed", error: string | null): void {
    this.logger.log({
      symbol: entry.signal.symbol, side: entry.side, qty: entry.qty,
      signalTs: entry.signal.timestamp, entryOrderType: "offset_limit",
      entryOffsetPercent: entry.offsetPercent, limitPrice: entry.price,
      minEntryDistancePercent: entry.minEntryDistancePercent, previousEntryPrice: entry.previousEntryPrice,
      actualEntryDistancePercent: entry.actualEntryDistancePercent,
      entryPriceRef: entry.price, refMarketPrice: entry.refPrice,
      sl: null, slOrderType: null, slBackupPrice: null, tp: null,
      status, bybitOrderId: entry.orderId, error,
    });
  }

  resume(release: (symbol: string) => void): void {
    for (const entry of this.entries.values()) {
      void this.wait(entry).finally(() => release(entry.signal.symbol));
    }
  }

  async execute(signal: CascadeSignal, onSkipped?: () => void): Promise<void> {
    if (this.busy.has(signal.symbol)) return;
    this.busy.add(signal.symbol);
    let entry: OffsetEntry | undefined;
    try {
      entry = await this.queue.run(signal.symbol, async () => {
        const side = resolveOrderSide(signal.direction);
        const [instrument, last, position] = await Promise.all([
          this.client.getInstrumentInfo(signal.symbol), this.client.getLastPrice(signal.symbol),
          this.client.getOpenPosition(signal.symbol),
        ]);
        const oppositePosition = position != null && position.side !== side;
        const price = offsetPrice(last, side, this.config.trading.entryOffsetPercent, instrument.tickSize);
        const minimum = this.config.trading.minEntryDistancePercent ?? 0;
        let previousEntryPrice: number | null = null;
        let actualEntryDistancePercent: number | null = null;
        if (!position) {
          // The exchange is authoritative: a manual full close starts a fresh entry cycle.
          this.lastFills.delete(`${signal.symbol}:Buy`);
          this.lastFills.delete(`${signal.symbol}:Sell`);
        } else if (!oppositePosition && minimum > 0) {
          const previous = this.lastFills.get(`${signal.symbol}:${side}`);
          if (!previous || previous.side !== side) {
            throw new EntryDistanceRejection(price, last, null, minimum, null);
          }
          previousEntryPrice = previous.price;
          actualEntryDistancePercent = entryDistancePercent(previous.price, price, side);
          if (!meetsEntryDistance(previous.price, price, side, minimum)) {
            throw new EntryDistanceRejection(price, last, previous.price, minimum, actualEntryDistancePercent);
          }
        }
        const qty = Math.max(instrument.minOrderQty,
          roundDownToStep(this.config.trading.positionSizeUsdt / price, instrument.qtyStep));
        const exits = calcExitPrices(side, price, this.config.trading.stopLossPercent, null);
        // A reducing order must not attach a stop for the opposite side to the current position.
        // The executor protects a reversed position after execution.
        const stopLoss = oppositePosition || exits.stopLoss === null ? null : placeablePrice(roundToTick(exits.stopLoss, instrument.tickSize));
        if (!oppositePosition && exits.stopLoss !== null && stopLoss === null) throw new Error("Invalid offset entry protective stop");
        const prepared: OffsetEntry = { signal, side, qty, refPrice: last, price,
          offsetPercent: this.config.trading.entryOffsetPercent,
          minEntryDistancePercent: minimum, previousEntryPrice, actualEntryDistancePercent, orderLinkId: `off-${randomUUID().replaceAll("-", "")}`,
          orderId: null };
        this.entries.set(signal.symbol, prepared);
        try { this.save(); } catch (err) {
          this.entries.delete(signal.symbol);
          throw err; // Nothing has been submitted yet.
        }
        try {
          prepared.orderId = await this.client.submitLimitOrder({
            symbol: signal.symbol, side, qty, price, orderLinkId: prepared.orderLinkId, stopLoss,
          });
          this.save();
          this.log(prepared, "submitted", null);
        } catch (err) {
          if ((err as { definitiveRejection?: boolean }).definitiveRejection) {
            this.entries.delete(signal.symbol);
            this.save();
            throw err;
          }
          // The exchange may have accepted it. Keep durable state and reconcile by link ID.
          console.error(`[offset-entry] ${signal.symbol} submit uncertain; reconciling ${prepared.orderLinkId}:`, err);
        }
        return prepared;
      });
    } catch (err) {
      // A failed durable save after submission must NOT release the symbol or lose the order.
      entry = this.entries.get(signal.symbol);
      if (!entry) {
        this.busy.delete(signal.symbol);
        const rejected = err instanceof EntryDistanceRejection ? err : null;
        if (rejected) onSkipped?.();
        this.logger.log({ symbol: signal.symbol, side: resolveOrderSide(signal.direction), qty: null,
          signalTs: signal.timestamp, entryOrderType: "offset_limit", entryPriceRef: rejected?.price ?? signal.lastBankruptcyPrice,
          limitPrice: rejected?.price, refMarketPrice: rejected?.last ?? null,
          minEntryDistancePercent: rejected?.minimum, previousEntryPrice: rejected?.previous,
          actualEntryDistancePercent: rejected?.distance,
          entryOutcome: rejected ? (rejected.previous === null ? "entry_reference_missing" : "min_entry_distance") : undefined,
          sl: null, slOrderType: null, slBackupPrice: null, tp: null,
          status: rejected ? "skipped" : "failed", bybitOrderId: null, error: String(err) });
        return;
      }
      console.error(`[offset-entry] ${signal.symbol} preparation uncertain; reconciling:`, err);
    }
    await this.wait(entry);
  }

  private async wait(entry: OffsetEntry): Promise<void> {
    let failures = 0;
    let terminalHandled = false;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const state = await this.client.getOrderState(entry.signal.symbol, entry.orderId ?? undefined, entry.orderLinkId);
        if (!state) {
          if (failures++ % 60 === 0) console.error(`[offset-entry] ${entry.signal.symbol} order not found yet: ${entry.orderLinkId}; no resubmit`);
          continue;
        }
        if (!entry.orderId && state.orderId) {
          entry.orderId = state.orderId;
          this.save();
        }
        if (!isTerminal(state)) continue;
        if (entry.orderId && this.finalizedIds.has(entry.orderId)) terminalHandled = true;
        if (!terminalHandled && state.cumExecQty > 0) {
          if (!(state.avgPrice > 0)) throw new Error("Filled order has no valid average price yet");
          await this.onFill({ entry, qty: state.cumExecQty, avgPrice: state.avgPrice,
            filledAt: Date.now(), outcome: state.orderStatus });
          this.lastFills.set(`${entry.signal.symbol}:${entry.side}`, { side: entry.side, price: state.avgPrice, ts: Date.now() });
          if (entry.orderId) this.finalizedIds.add(entry.orderId);
        } else if (!terminalHandled) {
          this.log(entry, state.orderStatus === "Rejected" ? "failed" : "cancelled",
            state.rejectReason ?? state.orderStatus);
        }
        terminalHandled = true;
        this.entries.delete(entry.signal.symbol);
        try { this.save(); } catch (err) { this.entries.set(entry.signal.symbol, entry); throw err; }
        this.busy.delete(entry.signal.symbol);
        return;
      } catch (err) {
        if (failures++ % 30 === 0) console.error(`[offset-entry] ${entry.signal.symbol} poll/reconcile failed; retaining order:`, err);
      }
    }
  }
}

function isTerminal(state: OrderState): boolean {
  return ["Filled", "Cancelled", "Rejected", "PartiallyFilledCanceled", "Deactivated"].includes(state.orderStatus);
}
