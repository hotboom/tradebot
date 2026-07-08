import fs from "node:fs";
import path from "node:path";

/**
 * Идемпотентность: файловое хранилище ключей обработанных сигналов
 * (symbol + timestamp). При рестарте ключи восстанавливаются из файла.
 */
export class DedupStore {
  private readonly filePath: string;
  private readonly keys = new Set<string>();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath)) {
      const lines = fs.readFileSync(this.filePath, "utf-8").split("\n");
      for (const line of lines) {
        const key = line.trim();
        if (key) this.keys.add(key);
      }
    }
  }

  static key(symbol: string, timestamp: number): string {
    return `${symbol}:${timestamp}`;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    fs.appendFileSync(this.filePath, key + "\n", "utf-8");
  }
}
