// РУЧНАЯ ПРОВЕРКА (read-only, реальные деньги, ничего не меняет на бирже): показывает, что
// сделал бы BreakevenMonitor для текущей открытой позиции по указанному символу — не
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

  console.log("[dry-run] raw position:", position);

  const { side, avgPrice, markPrice, stopLoss } = position;
  const sign = side === "Buy" ? 1 : -1;
  const profitPercent = ((markPrice - avgPrice) / avgPrice) * 100 * sign;

  const [instrument, feeRate] = await Promise.all([
    client.getInstrumentInfo(symbol),
    client.getFeeRate(symbol),
  ]);

  const roundTripFeeRate = feeRate.takerFeeRate * 2;
  const breakevenPrice = roundToTick(avgPrice * (1 + sign * roundTripFeeRate), instrument.tickSize);
  const backupPrice = roundToTick(
    avgPrice * (1 + sign * roundTripFeeRate * SL_BACKUP_BUFFER_MULTIPLIER),
    instrument.tickSize
  );

  const triggerPercent = config.trading.breakevenTriggerPercent;
  const triggered = profitPercent >= triggerPercent;
  const alreadyProtected =
    stopLoss !== null && (side === "Buy" ? stopLoss >= breakevenPrice : stopLoss <= breakevenPrice);

  console.log(`[dry-run] side=${side} avgPrice=${avgPrice} markPrice=${markPrice}`);
  console.log(
    `[dry-run] profitPercent=${profitPercent.toFixed(4)}% trigger=${triggerPercent}% -> ${
      triggered ? "TRIGGERED" : "not yet"
    }`
  );
  console.log(
    `[dry-run] taker fee rate=${feeRate.takerFeeRate} (round-trip=${(roundTripFeeRate * 100).toFixed(4)}%)`
  );
  console.log(`[dry-run] current stopLoss on exchange=${stopLoss}`);
  console.log(`[dry-run] would-be breakeven SL (Limit)=${breakevenPrice}`);
  console.log(`[dry-run] would-be backup SL (Market)=${backupPrice}`);
  console.log(`[dry-run] already protected at/beyond breakeven? ${alreadyProtected}`);
  console.log(`[dry-run] breakevenEnabled in config.json = ${config.trading.breakevenEnabled}`);
  console.log(`[dry-run] checkIntervalSec in config.json = ${config.trading.breakevenCheckIntervalSec}`);
  console.log("[dry-run] NOTE: read-only — no orders were placed or cancelled by this script.");
}

main().catch((err) => {
  console.error("[dry-run] FAILED:", err);
  process.exit(1);
});
