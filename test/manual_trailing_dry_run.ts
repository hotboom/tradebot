// РУЧНАЯ ПРОВЕРКА (read-only, реальные деньги, ничего не меняет на бирже): показывает, что
// сделал бы TrailingStopMonitor для текущей открытой позиции по указанному символу — не
// выставляет и не отменяет никакие ордера, только читает состояние позиции.
import "dotenv/config";
import { BybitClient } from "../src/bybit/client";
import { loadConfig } from "../src/config";
import { SL_BACKUP_BUFFER_MULTIPLIER } from "../src/decision/exits";
import { roundToTick } from "../src/util/rounding";

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? "CASHCATUSDT";
  const config = loadConfig();
  const client = new BybitClient(config.bybit.testnet);

  const positions = await client.getOpenPositions();
  const position = positions.find((p) => p.symbol === symbol);
  if (!position) {
    console.log(`[dry-run] no open position for ${symbol}`);
    console.log(`[dry-run] all open positions: ${positions.map((p) => p.symbol).join(", ") || "(none)"}`);
    return;
  }

  console.log("[dry-run] raw position (note: stopLoss/takeProfit here reflect only tpslMode");
  console.log("[dry-run] 'Full' stops — this bot always uses 'Partial', see stop orders below):", position);

  const { side, avgPrice, markPrice } = position;
  const sign = side === "Buy" ? 1 : -1;
  const profitPercent = ((markPrice - avgPrice) / avgPrice) * 100 * sign;

  const [instrument, stopOrders] = await Promise.all([
    client.getInstrumentInfo(symbol),
    client.getOpenStopOrders(symbol),
  ]);

  console.log("[dry-run] resident stop orders (the ones the monitor actually checks):", stopOrders);
  const existingSl = stopOrders.find((o) => o.stopOrderType === "PartialStopLoss");
  const existingTp = stopOrders.find((o) => o.stopOrderType === "PartialTakeProfit");

  const triggerPercent = config.trading.trailingTriggerPercent;
  const trailingDistance = config.trading.trailingStopPercent / 100;
  const triggered = profitPercent >= triggerPercent;

  const candidatePrice = roundToTick(markPrice * (1 - sign * trailingDistance), instrument.tickSize);
  const backupPrice = roundToTick(
    markPrice * (1 - sign * trailingDistance * SL_BACKUP_BUFFER_MULTIPLIER),
    instrument.tickSize
  );

  const isImprovement =
    existingSl === undefined ||
    (side === "Buy" ? candidatePrice > existingSl.triggerPrice : candidatePrice < existingSl.triggerPrice);

  console.log(`[dry-run] side=${side} avgPrice=${avgPrice} markPrice=${markPrice}`);
  console.log(
    `[dry-run] profitPercent=${profitPercent.toFixed(4)}% trigger=${triggerPercent}% -> ${
      triggered ? "TRIGGERED" : "not yet"
    }`
  );
  console.log(`[dry-run] existing PartialStopLoss trigger=${existingSl ? existingSl.triggerPrice : null}`);
  console.log(`[dry-run] existing PartialTakeProfit trigger=${existingTp ? existingTp.triggerPrice : null}`);
  console.log(`[dry-run] would-be trailing SL (Limit)=${candidatePrice} (distance ${config.trading.trailingStopPercent}% from markPrice)`);
  console.log(`[dry-run] would-be backup SL (Market)=${backupPrice}`);
  console.log(
    `[dry-run] would move stop now? ${triggered && isImprovement} ` +
      `(triggered=${triggered}, isImprovement=${isImprovement})`
  );
  console.log(`[dry-run] trailingEnabled in config.json = ${config.trading.trailingEnabled}`);
  console.log(`[dry-run] checkIntervalSec in config.json = ${config.trading.trailingCheckIntervalSec}`);
  console.log("[dry-run] NOTE: read-only — no orders were placed or cancelled by this script.");
}

main().catch((err) => {
  console.error("[dry-run] FAILED:", err);
  process.exit(1);
});
