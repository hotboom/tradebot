import { JsonlLogger } from "./jsonlLogger";
import type { BreakevenLogEntry } from "../types";

export class BreakevenLogger {
  private readonly logger: JsonlLogger<BreakevenLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<BreakevenLogEntry>(filePath);
  }

  log(entry: Omit<BreakevenLogEntry, "ts">): void {
    this.logger.write({ ts: Date.now(), ...entry });
  }
}
