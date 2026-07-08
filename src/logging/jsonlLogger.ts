import fs from "node:fs";
import path from "node:path";

/** Append-only JSON Lines логгер: одна запись — одна строка JSON. */
export class JsonlLogger<T> {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  write(entry: T): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      // Логирование не должно ронять процесс
      console.error(`Failed to write log to ${this.filePath}:`, err);
    }
  }
}
