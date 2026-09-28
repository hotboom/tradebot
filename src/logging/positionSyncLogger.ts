import { JsonlLogger } from "./jsonlLogger";
import type { PositionSyncLogEntry } from "../types";

export class PositionSyncLogger {
  private readonly logger: JsonlLogger<PositionSyncLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<PositionSyncLogEntry>(filePath);
  }

  log(entry: Omit<PositionSyncLogEntry, "ts">): void {
    this.logger.write({ ts: Date.now(), ...entry });
  }
}
