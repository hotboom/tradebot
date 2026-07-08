import { JsonlLogger } from "./jsonlLogger";
import type { CascadeSignal, SignalDecision, SignalLogEntry, SignalRejectReason } from "../types";

export class SignalsLogger {
  private readonly logger: JsonlLogger<SignalLogEntry>;

  constructor(filePath: string) {
    this.logger = new JsonlLogger<SignalLogEntry>(filePath);
  }

  log(
    signal: Partial<CascadeSignal> | null,
    decision: SignalDecision,
    reason: SignalRejectReason | null
  ): void {
    this.logger.write({
      ts: Date.now(),
      eventTs: signal?.timestamp ?? null,
      symbol: signal?.symbol ?? null,
      direction: signal?.direction ?? null,
      totalVolumeUsdt: signal?.totalVolumeUsdt ?? null,
      orderCount: signal?.orderCount ?? null,
      lastBankruptcyPrice: signal?.lastBankruptcyPrice ?? null,
      windowMs: signal?.windowMs ?? null,
      decision,
      reason,
    });
  }
}
