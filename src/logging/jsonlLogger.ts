import fs from "node:fs";
import path from "node:path";

/**
 * Append-only JSON Lines логгер: одна запись — одна строка JSON.
 *
 * Если задан `maxBytes`, файл ведёт себя как кольцевой буфер по размеру: при превышении лимита
 * самые старые строки отбрасываются (файл переписывается целиком), остаётся хвост ~KEEP_RATIO
 * от лимита. Проверка размера — не на каждую запись, а раз в CHECK_EVERY_BYTES дописанных данных,
 * чтобы не стат-ить файл в горячем цикле OBI-гейта. Режем только по границам строк.
 */
export class JsonlLogger<T> {
  private readonly filePath: string;
  private readonly maxBytes: number | null;
  private bytesSinceCheck = 0;

  private static readonly CHECK_EVERY_BYTES = 512 * 1024;
  private static readonly KEEP_RATIO = 0.7;

  constructor(filePath: string, opts?: { maxBytes?: number }) {
    this.filePath = path.resolve(filePath);
    this.maxBytes = opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : null;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  write(entry: T): void {
    const line = JSON.stringify(entry) + "\n";
    try {
      fs.appendFileSync(this.filePath, line, "utf-8");
    } catch (err) {
      // Логирование не должно ронять процесс
      console.error(`Failed to write log to ${this.filePath}:`, err);
      return;
    }

    if (this.maxBytes === null) return;
    this.bytesSinceCheck += Buffer.byteLength(line);
    if (this.bytesSinceCheck < JsonlLogger.CHECK_EVERY_BYTES) return;
    this.bytesSinceCheck = 0;
    this.trimToMaxBytes();
  }

  private trimToMaxBytes(): void {
    if (this.maxBytes === null) return;
    try {
      const { size } = fs.statSync(this.filePath);
      if (size <= this.maxBytes) return;

      const buf = fs.readFileSync(this.filePath);
      const target = Math.floor(this.maxBytes * JsonlLogger.KEEP_RATIO);
      let start = Math.max(0, buf.length - target);
      // Сдвигаемся вперёд до начала следующей целой строки, чтобы не оставить обрывок.
      const nl = buf.indexOf(0x0a, start);
      if (nl !== -1 && nl + 1 < buf.length) start = nl + 1;

      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, buf.subarray(start));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`Failed to trim log ${this.filePath}:`, err);
    }
  }
}
