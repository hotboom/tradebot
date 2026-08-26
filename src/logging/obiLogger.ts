import { JsonlLogger } from "./jsonlLogger";
import type { ObiLogEntry } from "../types";

/** Логирует каждый замер OBI во время окна ожидания разворота после сигнала — для
 * последующего анализа каскадов (см. src/obi/obiEntryGate.ts). */
export class ObiLogger {
  private readonly logger: JsonlLogger<ObiLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<ObiLogEntry>(filePath);
  }

  log(entry: Omit<ObiLogEntry, "ts">): void {
    this.logger.write({ ts: Date.now(), ...entry });
  }
}
