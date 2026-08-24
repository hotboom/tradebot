export function roundDownToStep(value: number, step: number): number {
  const rounded = Math.floor(value / step) * step;
  // отбрасываем плавающий "хвост" вида 0.30000000000000004
  const decimals = (step.toString().split(".")[1] ?? "").length;
  return Number(rounded.toFixed(decimals));
}

export function roundToTick(value: number, tick: number): number {
  const rounded = Math.round(value / tick) * tick;
  const decimals = (tick.toString().split(".")[1] ?? "").length;
  return Number(rounded.toFixed(decimals));
}
