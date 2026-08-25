/**
 * Сериализует асинхронные задачи по ключу (символу), чтобы независимые механизмы, управляющие
 * условными ордерами одной и той же позиции — вход (executor.ts), перенос SL в безубыток
 * (breakevenMonitor.ts) и trailing-stop (trailingStopMonitor.ts) — не гонялись друг за другом
 * за состоянием биржи (один читает открытые стоп-ордера, пока второй их уже отменяет/пересоздаёт).
 * Разные символы друг друга не блокируют.
 */
export class SymbolQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);
    // Хвост очереди никогда не должен зафейлиться — иначе следующая задача для этого же
    // символа не запустится вовсе.
    this.tails.set(key, result.then(() => undefined, () => undefined));
    return result;
  }
}
