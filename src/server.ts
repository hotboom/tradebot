import "dotenv/config";
import Fastify, { type FastifyError } from "fastify";
import { loadConfig } from "./config";
import { cascadeSignalSchema } from "./schema/cascadeSignal";
import { checkThreshold, checkDirection } from "./decision/filters";
import { BybitClient } from "./bybit/client";
import { SignalsLogger } from "./logging/signalsLogger";
import { OrdersLogger } from "./logging/ordersLogger";
import { ObiLogger } from "./logging/obiLogger";
import { BreakevenLogger } from "./logging/breakevenLogger";
import { TrailingLogger } from "./logging/trailingLogger";
import { OrderExecutor } from "./executor";
import { BreakevenMonitor } from "./breakevenMonitor";
import { TrailingStopMonitor } from "./trailingStopMonitor";
import { SymbolQueue } from "./util/symbolQueue";
import { DedupStore } from "./dedupStore";
import { PositionRateLimiter } from "./positionRateLimiter";
import { SymbolCooldown } from "./symbolCooldown";
import { startAdminServerIfEnabled } from "./admin/index";
import { isTradingPaused } from "./tradingState";
import path from "node:path";

async function main(): Promise<void> {
  startAdminServerIfEnabled();

  const config = loadConfig();

  const signalsLogger = new SignalsLogger(config.logging.signalsLogPath);
  const ordersLogger = new OrdersLogger(config.logging.ordersLogPath);
  const obiLogger = new ObiLogger(config.logging.obiLogPath);
  const breakevenLogger = new BreakevenLogger(config.logging.breakevenLogPath);
  const trailingLogger = new TrailingLogger(config.logging.trailingLogPath);
  const dedupStore = new DedupStore(
    path.join(path.dirname(path.resolve(config.logging.signalsLogPath)), "processed_signals.log")
  );
  const positionLimiter = new PositionRateLimiter(config.trading.maxPositionsPer10Min);
  // Per-symbol cooldown: lqmonitor_obi шлёт всплески почти-дублей по одному символу за
  // секунды (каждый со своим timestamp, поэтому DedupStore их не ловит). После первого
  // принятого сигнала по символу глушим последующие по нему на symbolCooldownSec — иначе
  // всплеск плодит задачи OBI-гейта и выжирает слоты maxPositionsPer10Min на одном символе.
  const symbolCooldown = new SymbolCooldown(config.trading.symbolCooldownSec * 1000);

  const bybitClient = new BybitClient(config.bybit.testnet);
  // Держим соединение с Bybit тёплым, чтобы первый замер стакана в OBI-гейте не платил
  // ~160мс на TCP+TLS (см. BybitClient.startConnectionWarmup / obi/obiEntryGate.ts).
  bybitClient.startConnectionWarmup();
  // Общая очередь: сериализует доступ к условным ордерам позиции по символу между executor'ом,
  // breakeven- и trailing-мониторами (см. SymbolQueue).
  const symbolQueue = new SymbolQueue();
  const breakevenMonitor = new BreakevenMonitor(config, bybitClient, breakevenLogger, symbolQueue);
  const trailingStopMonitor = new TrailingStopMonitor(config, bybitClient, trailingLogger, symbolQueue);
  const executor = new OrderExecutor(
    config,
    bybitClient,
    ordersLogger,
    obiLogger,
    breakevenMonitor,
    trailingStopMonitor,
    symbolQueue,
    positionLimiter
  );

  // На случай рестарта процесса (pm2 autorestart/деплой) с уже открытой позицией: если
  // позиций нет, монитор тут же остановит сам себя на первом тике (см. BreakevenMonitor.tick /
  // TrailingStopMonitor.tick).
  breakevenMonitor.start();
  trailingStopMonitor.start();

  const app = Fastify({ logger: true });

  // Заполняем кэш метаданных всех linear-инструментов одним bulk-запросом до приёма сигналов,
  // чтобы расчёт объёма ордера в горячем пути входа не платил за отдельный
  // getInstrumentsInfo(symbol) — особенно на первом (и любом редком) символе. Ошибка не
  // критична: getInstrumentInfo дозагрузит символ лениво (см. BybitClient.preloadInstruments).
  try {
    const instrumentCount = await bybitClient.preloadInstruments();
    app.log.info({ instrumentCount }, "bybit instrument cache preloaded");
  } catch (err) {
    app.log.warn({ err }, "bybit instrument preload failed, continuing with lazy per-symbol load");
  }
  bybitClient.startInstrumentRefresh();

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

    // Per-symbol cooldown: свежий всплеск почти-дублей по этому символу уже был принят —
    // глушим, чтобы не плодить задачи OBI-гейта. Порог 0 отключает (см. SymbolCooldown).
    if (symbolCooldown.isBlocked(signal.symbol, Date.now())) {
      signalsLogger.log(signal, "rejected", "symbol_cooldown");
      return reply.code(200).send({ decision: "rejected", reason: "symbol_cooldown" });
    }

    // Защита от лавины сигналов при обвале рынка: не более N новых позиций в скользящий час.
    // Быстрый предварительный отказ здесь; финальная проверка + учёт открытия — в executor'е,
    // непосредственно перед входом (после OBI-гейта — см. execute()), а не на каждую попытку.
    if (!positionLimiter.canOpen(Date.now())) {
      signalsLogger.log(signal, "rejected", "hourly_limit");
      return reply.code(200).send({ decision: "rejected", reason: "hourly_limit" });
    }

    signalsLogger.log(signal, "accepted", null);
    // Запускаем окно кулдауна только на реальном приёме (не на пути hourly_limit выше).
    symbolCooldown.record(signal.symbol, Date.now());

    // Идемпотентность: повторный сигнал (symbol + timestamp) не создаёт новый ордер
    const dedupKey = DedupStore.key(signal.symbol, signal.timestamp);
    if (dedupStore.has(dedupKey)) {
      return reply.code(200).send({ decision: "accepted", duplicate: true });
    }
    dedupStore.add(dedupKey);

    // Исполнение асинхронно (ждёт разворота OBI, затем входит — см. executor.ts), ошибки
    // логируются внутри executor'а
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
