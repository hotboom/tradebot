import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type EnvFormValues = {
  bybitApiKey: string;
  bybitApiKeyClear: boolean;
  bybitApiSecret: string;
  bybitApiSecretClear: boolean;
  bybitTestnet: boolean;
  serverHost: string;
  serverPort: string;
  minLiquidationUsdt: string;
  positionSizeUsdt: string;
  entryOrderType: string;
  stopLossPercent: string;
  stopLossOrderType: string;
  takeProfitPercent: string;
  maxPositionsPer10Min: string;
  direction: string;
  breakevenEnabled: boolean;
  breakevenTriggerPercent: string;
  breakevenCheckIntervalSec: string;
};

export type LoadedEnv = {
  values: EnvFormValues;
  bybitApiKeySet: boolean;
  bybitApiSecretSet: boolean;
};

type EnvEntry = {
  key: string;
  value: string;
};

type TradingConfig = {
  server: {
    port: number;
    host: string;
  };
  bybit: {
    testnet: boolean;
  };
  trading: {
    minLiquidationUsdt: number;
    positionSizeUsdt: number;
    entryOrderType: "market" | "limit";
    stopLossPercent: number | null;
    stopLossOrderType: "market" | "limit";
    takeProfitPercent: number | null;
    maxPositionsPer10Min: number;
    direction: "both" | "long" | "short";
    breakevenEnabled: boolean;
    breakevenTriggerPercent: number;
    breakevenCheckIntervalSec: number;
  };
  logging: {
    signalsLogPath: string;
    ordersLogPath: string;
    breakevenLogPath: string;
  };
};

const PROJECT_ROOT = process.cwd();
const ENV_PATH = join(PROJECT_ROOT, ".env");
const CONFIG_PATH = join(PROJECT_ROOT, "config.json");

const EDITABLE_ENV_KEYS = ["BYBIT_API_KEY", "BYBIT_API_SECRET"] as const;

function normalizeNumberInput(value: string): string {
  return value.replace(/[\s_,]/g, "");
}

function parsePositiveNumber(value: string, label: string): number {
  const normalized = normalizeNumberInput(value);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parseOptionalPositiveNumber(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return parsePositiveNumber(trimmed, label);
}

function parsePositiveInteger(value: string, label: string): number {
  const normalized = normalizeNumberInput(value);
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value: string, label: string): number {
  const parsed = parsePositiveInteger(value, label);
  if (parsed > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return parsed;
}

function parseDirection(value: string): "both" | "long" | "short" {
  if (value !== "both" && value !== "long" && value !== "short") {
    throw new Error("Direction must be one of: both, long, short");
  }
  return value;
}

function parseStopLossOrderType(value: string): "market" | "limit" {
  if (value !== "market" && value !== "limit") {
    throw new Error("Stop loss order type must be one of: market, limit");
  }
  return value;
}

function parseEntryOrderType(value: string): "market" | "limit" {
  if (value !== "market" && value !== "limit") {
    throw new Error("Entry order type must be one of: market, limit");
  }
  return value;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.${Date.now()}.${randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    entries.push({ key: match[1], value: match[2] });
  }
  return entries;
}

function envMap(entries: EnvEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.key, entry.value]));
}

async function readEnvEntries(): Promise<EnvEntry[]> {
  try {
    return parseEnv(await fs.readFile(ENV_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function formatEnv(values: Map<string, string>, originalEntries: EnvEntry[]): string {
  const known = EDITABLE_ENV_KEYS.map((key) => `${key}=${values.get(key) ?? ""}`);
  const editableKeys = new Set<string>(EDITABLE_ENV_KEYS);
  const unknown = originalEntries.filter((entry) => !editableKeys.has(entry.key)).map((entry) => `${entry.key}=${entry.value}`);

  return `${[...known, ...unknown].join("\n")}\n`;
}

async function readConfig(): Promise<TradingConfig> {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as TradingConfig;
}

export async function loadEnv(): Promise<LoadedEnv> {
  const entries = await readEnvEntries();
  const values = envMap(entries);
  const config = await readConfig();

  const bybitApiKey = values.get("BYBIT_API_KEY") ?? "";
  const bybitApiSecret = values.get("BYBIT_API_SECRET") ?? "";

  return {
    bybitApiKeySet: bybitApiKey.length > 0,
    bybitApiSecretSet: bybitApiSecret.length > 0,
    values: {
      bybitApiKey: "",
      bybitApiKeyClear: false,
      bybitApiSecret: "",
      bybitApiSecretClear: false,
      bybitTestnet: config.bybit.testnet,
      serverHost: config.server.host,
      serverPort: String(config.server.port),
      minLiquidationUsdt: String(config.trading.minLiquidationUsdt),
      positionSizeUsdt: String(config.trading.positionSizeUsdt),
      entryOrderType: config.trading.entryOrderType ?? "market",
      stopLossPercent: config.trading.stopLossPercent !== null ? String(config.trading.stopLossPercent) : "",
      stopLossOrderType: config.trading.stopLossOrderType ?? "market",
      takeProfitPercent: config.trading.takeProfitPercent !== null ? String(config.trading.takeProfitPercent) : "",
      maxPositionsPer10Min: String(config.trading.maxPositionsPer10Min),
      direction: config.trading.direction ?? "both",
      breakevenEnabled: config.trading.breakevenEnabled ?? false,
      breakevenTriggerPercent: String(config.trading.breakevenTriggerPercent ?? 1),
      breakevenCheckIntervalSec: String(config.trading.breakevenCheckIntervalSec ?? 60)
    }
  };
}

export async function saveEnv(input: EnvFormValues): Promise<void> {
  const entries = await readEnvEntries();
  const values = envMap(entries);

  const currentKey = values.get("BYBIT_API_KEY") ?? "";
  const newKey = input.bybitApiKey.trim();
  if (input.bybitApiKeyClear) {
    values.set("BYBIT_API_KEY", "");
  } else if (newKey) {
    values.set("BYBIT_API_KEY", newKey);
  } else {
    values.set("BYBIT_API_KEY", currentKey);
  }

  const currentSecret = values.get("BYBIT_API_SECRET") ?? "";
  const newSecret = input.bybitApiSecret.trim();
  if (input.bybitApiSecretClear) {
    values.set("BYBIT_API_SECRET", "");
  } else if (newSecret) {
    values.set("BYBIT_API_SECRET", newSecret);
  } else {
    values.set("BYBIT_API_SECRET", currentSecret);
  }

  const serverPort = parsePort(input.serverPort, "Server port");
  const serverHost = input.serverHost.trim();
  if (!serverHost) {
    throw new Error("Server host must not be empty");
  }

  const minLiquidationUsdt = parsePositiveNumber(input.minLiquidationUsdt, "Min liquidation USDT");
  const positionSizeUsdt = parsePositiveNumber(input.positionSizeUsdt, "Position size USDT");
  const entryOrderType = parseEntryOrderType(input.entryOrderType);
  const stopLossPercent = parseOptionalPositiveNumber(input.stopLossPercent, "Stop loss %");
  const stopLossOrderType = parseStopLossOrderType(input.stopLossOrderType);
  const takeProfitPercent = parseOptionalPositiveNumber(input.takeProfitPercent, "Take profit %");
  const maxPositionsPer10Min = parsePositiveInteger(input.maxPositionsPer10Min, "Max positions per 10 min");
  const direction = parseDirection(input.direction);
  const breakevenTriggerPercent = parsePositiveNumber(input.breakevenTriggerPercent, "Breakeven trigger %");
  const breakevenCheckIntervalSec = parsePositiveInteger(input.breakevenCheckIntervalSec, "Breakeven check interval (sec)");

  const currentConfig = await readConfig();
  const nextConfig: TradingConfig = {
    server: { port: serverPort, host: serverHost },
    bybit: { testnet: input.bybitTestnet },
    trading: {
      minLiquidationUsdt,
      positionSizeUsdt,
      entryOrderType,
      stopLossPercent,
      stopLossOrderType,
      takeProfitPercent,
      maxPositionsPer10Min,
      direction,
      breakevenEnabled: input.breakevenEnabled,
      breakevenTriggerPercent,
      breakevenCheckIntervalSec
    },
    logging: currentConfig.logging
  };

  await atomicWrite(ENV_PATH, formatEnv(values, entries));
  await atomicWrite(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`);
}
