/**
 * Число знаков после запятой в шаге цены/объёма. Берём из экспоненциальной записи
 * (`toExponential`), а НЕ из `toString()`: для очень мелких шагов (tickSize <= 1e-7 —
 * например 0.0000001 у низкоценовых монет вроде MEMEUSDT) `Number.prototype.toString()`
 * переключается на форму "1e-7", в которой нет точки. Наивный `step.toString().split(".")[1]`
 * тогда даёт 0 знаков, `toFixed(0)` округляет всю дробную цену до 0, и на биржу уходит
 * stopLoss/takeProfit = 0 — Bybit трактует ноль как "снять стоп", позиция остаётся без защиты.
 */
function fractionDigits(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const [mantissa, exponent] = step.toExponential().split("e");
  const mantissaDecimals = (mantissa.split(".")[1] ?? "").length;
  const exp = Number(exponent);
  // toFixed поддерживает максимум 100 знаков после запятой.
  return Math.min(100, Math.max(0, mantissaDecimals - exp));
}

export function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return NaN;
  const rounded = Math.floor(value / step) * step;
  // отбрасываем плавающий "хвост" вида 0.30000000000000004
  return Number(rounded.toFixed(fractionDigits(step)));
}

export function roundToTick(value: number, tick: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return NaN;
  const rounded = Math.round(value / tick) * tick;
  return Number(rounded.toFixed(fractionDigits(tick)));
}

/**
 * Цену можно отправить на биржу как SL/TP/триггер только если это конечное положительное
 * число. Ноль, NaN и отрицательное — трактуем как "не задано": лучше явно не выставить
 * стоп и залогировать это, чем отправить Bybit stopLoss=0 (он воспримет его как снятие
 * стопа) и оставить позицию без защиты. Возвращает саму цену либо null.
 */
export function placeablePrice(price: number | null | undefined): number | null {
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}
