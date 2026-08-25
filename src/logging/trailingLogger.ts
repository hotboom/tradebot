import { JsonlLogger } from "./jsonlLogger";
import type { TrailingLogEntry } from "../types";

export class TrailingLogger {
  private readonly logger: JsonlLogger<TrailingLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<TrailingLogEntry>(filePath);
  }

  log(entry: Omit<TrailingLogEntry, "ts">): void {
    this.logger.write({ ts: Date.now(), ...entry });
  }
}
