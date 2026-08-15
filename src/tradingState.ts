import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// Флаг живёт в отдельном процессе-состоянии (не в config.json), чтобы старт/стоп
// торговли не требовал рестарта бота и не затрагивал остальные настройки.
// Персистится на диск, чтобы переживать перезапуск pm2 (autorestart/crash).
const STATE_PATH = join(process.cwd(), "trading-state.json");

type TradingState = {
  paused: boolean;
};

function readState(): TradingState {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<TradingState>;
    return { paused: parsed.paused === true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("failed to read trading-state.json, defaulting to running", error);
    }
    return { paused: false };
  }
}

let state: TradingState = readState();

function persist(): void {
  const tmpPath = join(dirname(STATE_PATH), `.${Date.now()}.${randomUUID()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmpPath, STATE_PATH);
}

export function isTradingPaused(): boolean {
  return state.paused;
}

export function setTradingPaused(paused: boolean): void {
  state = { paused };
  persist();
}
