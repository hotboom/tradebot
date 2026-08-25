import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const configSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().min(1),
  }),
  bybit: z.object({
    testnet: z.boolean(),
  }),
  trading: z.object({
    minLiquidationUsdt: z.number().positive(),
    positionSizeUsdt: z.number().positive(),
    entryOrderType: z.enum(["market", "limit"]).nullish().transform((v) => v ?? "market"),
    stopLossPercent: z.number().positive().nullish().transform((v) => v ?? null),
    stopLossOrderType: z.enum(["market", "limit"]).nullish().transform((v) => v ?? "market"),
    takeProfitPercent: z.number().positive().nullish().transform((v) => v ?? null),
    maxPositionsPer10Min: z.number().int().positive(),
    direction: z.enum(["both", "long", "short"]).default("both"),
    breakevenEnabled: z.boolean().nullish().transform((v) => v ?? false),
    breakevenTriggerPercent: z.number().positive().nullish().transform((v) => v ?? 1),
    breakevenCheckIntervalSec: z.number().int().positive().nullish().transform((v) => v ?? 60),
    trailingEnabled: z.boolean().nullish().transform((v) => v ?? false),
    trailingTriggerPercent: z.number().positive().nullish().transform((v) => v ?? 5),
    trailingStopPercent: z.number().positive().nullish().transform((v) => v ?? 1),
    trailingCheckIntervalSec: z.number().int().positive().nullish().transform((v) => v ?? 60),
  }),
  logging: z.object({
    signalsLogPath: z.string().min(1),
    ordersLogPath: z.string().min(1),
    breakevenLogPath: z.string().min(1).nullish().transform((v) => v ?? "./logs/breakeven.log"),
    trailingLogPath: z.string().min(1).nullish().transform((v) => v ?? "./logs/trailing.log"),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(configPath?: string): AppConfig {
  const resolved = path.resolve(
    configPath ?? process.env.CONFIG_PATH ?? path.join(__dirname, "..", "config.json")
  );
  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = configSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid config at ${resolved}: ${parsed.error.message}`);
  }
  return parsed.data;
}
