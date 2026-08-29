import { JsonlLogger } from "./jsonlLogger";
import type { ObiLogEntry, ObiGateEvent } from "../types";

/**
 * Логи OBI-гейта разнесены по двум файлам, чтобы анализ каскадов не тянул в контекст мегабайты
 * сырья:
 *  - `obi.log` — решения и итог по сигналу (extreme_seen / triggered / timeout / post_summary),
 *    ~2-3 строки на сигнал. Его и читает разбор.
 *  - `obi_trace.log` — пер-тик замеры (sample во время ожидания + post_sample на 10-мин
 *    пост-трекинге), десятки-сотни строк на сигнал. Кольцевой лимит по размеру: старое
 *    отваливается, но последних сделок всегда с запасом больше 100.
 */
const TRACE_EVENTS: ReadonlySet<ObiGateEvent> = new Set<ObiGateEvent>(["sample", "post_sample"]);

// ~16 МБ ≈ пост-трекинг по 200+ сигналам (при ~70 КБ сырья на сигнал с 10-мин окном) —
// гарантированно перекрывает "минимум 100 последних сделок".
const TRACE_MAX_BYTES = 16 * 1024 * 1024;
// Бэкстоп для основного лога: ~3 КБ на сигнал → 4 МБ ≈ ~1300 сигналов-сводок.
const MAIN_MAX_BYTES = 4 * 1024 * 1024;

function deriveTracePath(mainPath: string): string {
  return mainPath.endsWith(".log") ? `${mainPath.slice(0, -4)}_trace.log` : `${mainPath}.trace`;
}

/** Логирует ход OBI-гейта после сигнала — для последующего анализа каскадов
 * (см. src/obi/obiEntryGate.ts). */
export class ObiLogger {
  private readonly main: JsonlLogger<ObiLogEntry>;
  private readonly trace: JsonlLogger<ObiLogEntry>;

  constructor(filePath: string) {
    this.main = new JsonlLogger<ObiLogEntry>(filePath, { maxBytes: MAIN_MAX_BYTES });
    this.trace = new JsonlLogger<ObiLogEntry>(deriveTracePath(filePath), { maxBytes: TRACE_MAX_BYTES });
  }

  log(entry: Omit<ObiLogEntry, "ts">): void {
    const record: ObiLogEntry = { ts: Date.now(), ...entry };
    (TRACE_EVENTS.has(entry.event) ? this.trace : this.main).write(record);
  }
}
