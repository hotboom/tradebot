import { JsonlLogger } from "./jsonlLogger";
import type { MarketTpSlConversionLogEntry } from "../types";

export class MarketTpSlConversionLogger {
  private readonly logger: JsonlLogger<MarketTpSlConversionLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<MarketTpSlConversionLogEntry>(filePath);
  }

  log(entry: Omit<MarketTpSlConversionLogEntry, "ts">): void {
    this.logger.write({ ts: Date.now(), ...entry });
  }
}
