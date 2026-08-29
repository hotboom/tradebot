// Разовый фикс: восстанавливает основной лимитный SL (PartialStopLoss) на открытых позициях.
// Нужен после migrate-tp-to-limit.mjs: в tpslMode "Partial" отмена TP-ноги уносит и SL-ногу
// (OCO), backup-Stop остаётся. Пересоздаёт SL-ногу через setTradingStop (TP она больше не трогает).
//
// Запуск:  node scripts/restore-sl.mjs --apply SYMBOL [SYMBOL ...]
import "dotenv/config";
import { BybitClient } from "../dist/bybit/client.js";
import { roundToTick } from "../dist/util/rounding.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const symbols = args.filter((a) => a !== "--apply").map((s) => s.toUpperCase());
if (symbols.length === 0) {
  console.error("usage: node scripts/restore-sl.mjs [--apply] SYMBOL [SYMBOL ...]");
  process.exit(1);
}

const SL_PERCENT = 5; // trading.stopLossPercent из config.json
const client = new BybitClient(false);

for (const symbol of symbols) {
  console.log(`\n=== ${symbol} ===`);
  const pos = (await client.getOpenPositions()).find((p) => p.symbol === symbol);
  if (!pos) {
    console.log("нет открытой позиции — пропуск");
    continue;
  }
  const instrument = await client.getInstrumentInfo(symbol);
  const sign = pos.side === "Buy" ? 1 : -1;
  const sl = roundToTick(pos.avgPrice * (1 - (sign * SL_PERCENT) / 100), instrument.tickSize);

  const before = await client.getOpenStopOrders(symbol);
  console.log(`side=${pos.side} size=${pos.size} avgPrice=${pos.avgPrice}`);
  console.log(`stop-ордера сейчас: ${JSON.stringify(before)}`);
  console.log(`восстановлю PartialStopLoss (Limit) @ ${sl} x ${pos.size}`);

  if (!apply) {
    console.log("dry-run — добавь --apply");
    continue;
  }

  await client.setTradingStop({ symbol, qty: pos.size, stopLoss: sl, stopLossOrderType: "Limit" });
  console.log(`stop-ордера после: ${JSON.stringify(await client.getOpenStopOrders(symbol))}`);
  console.log(`reduce-only лимитки: ${JSON.stringify(await client.getOpenReduceOnlyLimitOrders(symbol))}`);
}

console.log("\nготово.");
