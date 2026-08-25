import "dotenv/config";
import Fastify, { type FastifyError } from "fastify";
import { loadConfig } from "./config";
import { cascadeSignalSchema } from "./schema/cascadeSignal";
import { checkThreshold, checkDirection } from "./decision/filters";
import { BybitClient } from "./bybit/client";
import { SignalsLogger } from "./logging/signalsLogger";
import { OrdersLogger } from "./logging/ordersLogger";
import { BreakevenLogger } from "./logging/breakevenLogger";
import { TrailingLogger } from "./logging/trailingLogger";
import { OrderExecutor } from "./executor";
import { BreakevenMonitor } from "./breakevenMonitor";
import { TrailingStopMonitor } from "./trailingStopMonitor";
import { SymbolQueue } from "./util/symbolQueue";
import { DedupStore } from "./dedupStore";
import { PositionRateLimiter } from "./positionRateLimiter";
import { startAdminServerIfEnabled } from "./admin/index";
import { isTradingPaused } from "./tradingState";
import path from "node:path";

async function main(): Promise<void> {
  startAdminServerIfEnabled();

  const config = loadConfig();

  const signalsLogger = new SignalsLogger(config.logging.signalsLogPath);
  const ordersLogger = new OrdersLogger(config.logging.ordersLogPath);
  const breakevenLogger = new BreakevenLogger(config.logging.breakevenLogPath);
  const trailingLogger = new TrailingLogger(config.logging.trailingLogPath);
  const dedupStore = new DedupStore(
    path.join(path.dirname(path.resolve(config.logging.signalsLogPath)), "processed_signals.log")
  );
  const positionLimiter = new PositionRateLimiter(config.trading.maxPositionsPer10Min);

  const bybitClient = new BybitClient(config.bybit.testnet);
  // Общая очередь: сериализует доступ к условным ордерам позиции по символу между executor'ом,
  // breakeven- и trailing-мониторами (см. SymbolQueue).
  const symbolQueue = new SymbolQueue();
  const breakevenMonitor = new BreakevenMonitor(config, bybitClient, breakevenLogger, symbolQueue);
  const trailingStopMonitor = new TrailingStopMonitor(config, bybitClient, trailingLogger, symbolQueue);
  const executor = new OrderExecutor(config, bybitClient, ordersLogger, breakevenMonitor, trailingStopMonitor, symbolQueue);

  // На случай рестарта процесса (pm2 autorestart/деплой) с уже открытой позицией: если
  // позиций нет, монитор тут же остановит сам себя на первом тике (см. BreakevenMonitor.tick /
  // TrailingStopMonitor.tick).
  breakevenMonitor.start();
  trailingStopMonitor.start();

  const app = Fastify({ logger: true });

  app.post("/signal/liquidation", async (request, reply) => {
    const parsed = cascadeSignalSchema.safeParse(request.body);
    if (!parsed.success) {
      const body = typeof request.body === "object" && request.body !== null ? request.body : null;
      signalsLogger.log(body as never, "rejected", "invalid_schema");
      return reply.code(400).send({ decision: "rejected", reason: "invalid_schema" });
    }
    const signal = parsed.data;

    // Стоп из админки: сигналы продолжают приниматься и логироваться, но новые сделки не открываются.
    if (isTradingPaused()) {
      signalsLogger.log(signal, "rejected", "trading_paused");
      return reply.code(200).send({ decision: "rejected", reason: "trading_paused" });
    }

    const directionFilter = checkDirection(signal, config.trading.direction);
    if (!directionFilter.accepted) {
      signalsLogger.log(signal, "rejected", directionFilter.reason);
      return reply.code(200).send({ decision: "rejected", reason: directionFilter.reason });
    }

    const filter = checkThreshold(signal, config.trading.minLiquidationUsdt);
    if (!filter.accepted) {
      signalsLogger.log(signal, "rejected", filter.reason);
      return reply.code(200).send({ decision: "rejected", reason: filter.reason });
    }

    // Защита от лавины сигналов при обвале рынка: не более N новых позиций в скользящий час
    if (!positionLimiter.canOpen(Date.now())) {
      signalsLogger.log(signal, "rejected", "hourly_limit");
      return reply.code(200).send({ decision: "rejected", reason: "hourly_limit" });
    }

    signalsLogger.log(signal, "accepted", null);

    // Идемпотентность: повторный сигнал (symbol + timestamp) не создаёт новый ордер
    const dedupKey = DedupStore.key(signal.symbol, signal.timestamp);
    if (dedupStore.has(dedupKey)) {
      return reply.code(200).send({ decision: "accepted", duplicate: true });
    }
    dedupStore.add(dedupKey);

    positionLimiter.recordOpen(Date.now());

    // Исполнение асинхронно, ошибки логируются внутри executor'а
    void executor.execute(signal);

    return reply.code(200).send({ decision: "accepted", duplicate: false });
  });

  // Некорректный JSON в теле запроса → 400 + запись в signals.log
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode === 400) {
      signalsLogger.log(null, "rejected", "invalid_schema");
      return reply.code(400).send({ decision: "rejected", reason: "invalid_schema" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  await app.listen({ host: config.server.host, port: config.server.port });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
