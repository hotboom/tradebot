// Только верификация — без открытия новой позиции.
import "dotenv/config";
import { RestClientV5 } from "bybit-api";

async function main(): Promise<void> {
  const symbol = "BTCUSDT";
  const key = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  const rest = new RestClientV5({ key, secret, enable_time_sync: true, syncTimeBeforePrivateRequests: true });

  const posRes = await rest.getPositionInfo({ category: "linear", symbol });
  const ordersRes = await rest.getActiveOrders({ category: "linear", symbol });

  console.log("--- Position ---");
  console.log(JSON.stringify(posRes.result.list, null, 2));
  console.log("\n--- Active orders (incl. conditional/trigger) ---");
  console.log(JSON.stringify(ordersRes.result.list, null, 2));

  const fs = await import("node:fs");
  console.log("\n--- test orders.log ---");
  console.log(fs.readFileSync("./logs/manual_dual_sl_test.log", "utf-8"));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
