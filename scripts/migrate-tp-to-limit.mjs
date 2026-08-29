// Разовая миграция: переносит take-profit открытых позиций со старого Partial-TP
// (setTradingStop, tpslMode "Partial") на обычный reduce-only лимитный ордер, которым
// можно свободно управлять вручную. SL и backup-SL не трогает.
//
// Запуск:  node scripts/migrate-tp-to-limit.mjs SYMBOL [SYMBOL ...]           (dry-run)
//          node scripts/migrate-tp-to-limit.mjs --apply SYMBOL [SYMBOL ...]   (выполнить)
import "dotenv/config";
import { BybitClient } from "../dist/bybit/client.js";
import { roundToTick } from "../dist/util/rounding.js";

// ВАЖНО: в tpslMode "Partial" SL- и TP-ноги связаны как OCO — отмена PartialTakeProfit
// деактивирует и PartialStopLoss. Поэтому после отмены легаси-TP пересоздаём SL-ногу
// (setTradingStop с одним stopLoss). backup-Stop (submitStopMarketOrder) не затрагивается.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const symbols = args.filter((a) => a !== "--apply").map((s) => s.toUpperCase());
if (symbols.length === 0) {
  console.error("usage: node scripts/migrate-tp-to-limit.mjs [--apply] SYMBOL [SYMBOL ...]");
  process.exit(1);
}

const TP_PERCENT = 11; // trading.takeProfitPercent из config.json
const SL_PERCENT = 5; // trading.stopLossPercent из config.json

const client = new BybitClient(false);

for (const symbol of symbols) {
  console.log(`\n=== ${symbol} ===`);
  const position = await client.getOpenPosition(symbol);
  if (!position) {
    console.log("нет открытой позиции — пропуск");
    continue;
  }
  const posSummary = (await client.getOpenPositions()).find((p) => p.symbol === symbol);
  const side = posSummary?.side ?? "Buy";
  const closingSide = side === "Buy" ? "Sell" : "Buy";
  const sign = side === "Buy" ? 1 : -1;

  const instrument = await client.getInstrumentInfo(symbol);
  const stopOrders = await client.getOpenStopOrders(symbol);
  const partialTp = stopOrders.find((o) => o.stopOrderType === "PartialTakeProfit");
  const existingRoLimit = await client.getOpenReduceOnlyLimitOrders(symbol);

  const targetTp = roundToTick(position.avgPrice * (1 + (sign * TP_PERCENT) / 100), instrument.tickSize);

  console.log(`side=${side} size=${position.size} avgPrice=${position.avgPrice}`);
  console.log(`legacy PartialTakeProfit: ${partialTp ? `trigger=${partialTp.triggerPrice} (id ${partialTp.orderId})` : "нет"}`);
  console.log(`уже есть reduce-only лимитки: ${existingRoLimit.length ? JSON.stringify(existingRoLimit) : "нет"}`);
  console.log(`target TP (${TP_PERCENT}% от avgPrice) = ${targetTp}, qty=${position.size}, side=${closingSide}`);

  if (!apply) {
    console.log("dry-run — ничего не делаю. Добавь --apply чтобы выполнить.");
    continue;
  }

  if (partialTp) {
    await client.cancelOrder({ symbol, orderId: partialTp.orderId });
    console.log(`отменил legacy PartialTakeProfit ${partialTp.orderId} (вместе с ним OCO-деактивируется PartialStopLoss)`);
    // Пересоздаём SL-ногу, которую унесло OCO.
    const sl = roundToTick(position.avgPrice * (1 - (sign * SL_PERCENT) / 100), instrument.tickSize);
    await client.setTradingStop({ symbol, qty: position.size, stopLoss: sl, stopLossOrderType: "Limit" });
    console.log(`восстановил PartialStopLoss (Limit) @ ${sl} x ${position.size}`);
  }
  for (const ro of existingRoLimit) {
    await client.cancelOrder({ symbol, orderId: ro.orderId });
    console.log(`отменил старую reduce-only лимитку ${ro.orderId}`);
  }
  const id = await client.submitTakeProfitLimitOrder({
    symbol,
    side: closingSide,
    qty: position.size,
    price: targetTp,
  });
  console.log(`поставил reduce-only лимитный TP: ${id} @ ${targetTp} x ${position.size}`);
}

console.log("\nготово.");
