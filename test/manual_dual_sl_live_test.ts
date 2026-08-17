// РУЧНОЙ ТЕСТ НА РЕАЛЬНЫЕ ДЕНЬГИ (mainnet). Открывает минимальную позицию Long по BTCUSDT
// через реальный OrderExecutor и проверяет, что встали оба SL: лимитный (по настройке %)
// и резервный маркет (на 10% дальше). Позицию НЕ закрывает — оставляет открытой.
import "dotenv/config";
import { RestClientV5 } from "bybit-api";
import { BybitClient } from "../src/bybit/client";
import { OrdersLogger } from "../src/logging/ordersLogger";
import { OrderExecutor } from "../src/executor";
import type { AppConfig } from "../src/config";
import type { CascadeSignal } from "../src/types";

async function main(): Promise<void> {
  const symbol = "BTCUSDT";
  const client = new BybitClient(false); // mainnet, реальные деньги

  const lastPrice = await client.getLastPrice(symbol);
  console.log(`[test] ${symbol} last price: ${lastPrice}`);

  const testConfig: AppConfig = {
    server: { port: 0, host: "127.0.0.1" },
    bybit: { testnet: false },
    trading: {
      minLiquidationUsdt: 80000,
      positionSizeUsdt: 10, // маленький номинал — код сам поднимет qty до биржевого минимума
      stopLossPercent: 2,
      stopLossOrderType: "limit",
      takeProfitPercent: 5,
      maxPositionsPerHour: 999,
      direction: "both",
    },
    logging: {
      signalsLogPath: "./logs/signals.log",
      ordersLogPath: "./logs/manual_dual_sl_test.log",
    },
  };

  const ordersLogger = new OrdersLogger(testConfig.logging.ordersLogPath);
  const executor = new OrderExecutor(testConfig, client, ordersLogger);

  const signal: CascadeSignal = {
    symbol,
    direction: "LONG",
    totalVolumeUsdt: 999999,
    orderCount: 1,
    lastBankruptcyPrice: lastPrice,
    windowMs: 1000,
    timestamp: Date.now(),
  };

  console.log("[test] executing signal via real OrderExecutor (REAL MONEY)...");
  await executor.execute(signal);

  // Даём бирже отразить условные ордера
  await new Promise((r) => setTimeout(r, 2500));

  const key = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  const verifyRest = new RestClientV5({ key, secret, enable_time_sync: true, syncTimeBeforePrivateRequests: true });

  const posRes = await verifyRest.getPositionInfo({ category: "linear", symbol });
  const ordersRes = await verifyRest.getActiveOrders({ category: "linear", symbol });

  console.log("\n[test] --- Position ---");
  console.log(JSON.stringify(posRes.result.list, null, 2));
  console.log("\n[test] --- Open orders (incl. conditional/trigger) ---");
  console.log(JSON.stringify(ordersRes.result.list, null, 2));

  console.log("\n[test] --- orders.log (this test run) ---");
  const fs = await import("node:fs");
  console.log(fs.readFileSync(testConfig.logging.ordersLogPath, "utf-8"));
}

main().catch((err) => {
  console.error("[test] FAILED:", err);
  process.exit(1);
});
