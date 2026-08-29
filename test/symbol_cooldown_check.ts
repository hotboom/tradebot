/**
 * Standalone-проверка SymbolCooldown (запуск: npx tsx test/symbol_cooldown_check.ts).
 * Юнит-фреймворка в проекте нет.
 */
import { SymbolCooldown } from "../src/symbolCooldown";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

// Окно 90с
const cd = new SymbolCooldown(90_000);
const t0 = 1_000_000;

check("1st signal passes", cd.isBlocked("ROBOUSDT", t0) === false);
cd.record("ROBOUSDT", t0);

check("2nd within window blocked (+30s)", cd.isBlocked("ROBOUSDT", t0 + 30_000) === true);
check("still blocked at edge (+89.999s)", cd.isBlocked("ROBOUSDT", t0 + 89_999) === true);
check("passes after window (+90s)", cd.isBlocked("ROBOUSDT", t0 + 90_000) === false);
check("different symbol unaffected", cd.isBlocked("BTCUSDT", t0 + 30_000) === false);

// re-record extends window
cd.record("ROBOUSDT", t0 + 90_000);
check("re-record restarts window", cd.isBlocked("ROBOUSDT", t0 + 100_000) === true);

// 0 disables
const off = new SymbolCooldown(0);
off.record("ROBOUSDT", t0);
check("0 disables cooldown", off.isBlocked("ROBOUSDT", t0 + 1) === false);

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
