import { JsonlLogger } from "./jsonlLogger";
import type { OrderLogEntry } from "../types";

export class OrdersLogger {
  private readonly logger: JsonlLogger<OrderLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<OrderLogEntry>(filePath);
  }

  log(entry: Omit<OrderLogEntry, "ts">): void {
    this.logger.write({ ts: Date.now(), ...entry });
  }
}
