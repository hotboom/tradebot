import { z } from "zod";

export const cascadeSignalSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(["LONG", "SHORT"]),
  totalVolumeUsdt: z.number().positive(),
  orderCount: z.number().int().positive(),
  lastBankruptcyPrice: z.number().positive(),
  windowMs: z.number().positive(),
  timestamp: z.number().positive(),
});

export type CascadeSignalParsed = z.infer<typeof cascadeSignalSchema>;
