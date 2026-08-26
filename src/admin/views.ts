import type { LoadedEnv } from "./config-store";

export type Notice = {
  type: "success" | "danger";
  message: string;
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function bootstrapHead(title: string): string {
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    html {
      font-size: 14px;
    }
    .help-icon {
      display: inline-flex;
      cursor: help;
      color: var(--bs-secondary-color);
      vertical-align: -0.1em;
    }
    .help-icon:hover {
      color: var(--bs-primary);
    }
  </style>`;
}

/** Кружок с вопросом рядом с полем: всплывающая подсказка (Bootstrap tooltip) по наведению/фокусу. */
function helpIcon(text: string): string {
  return `<span class="help-icon ms-1" tabindex="0" data-bs-toggle="tooltip" data-bs-placement="top" title="${escapeHtml(text)}">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
      <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.995.945-1.492.7-.518 1.353-1.084 1.353-2.132 0-1.51-1.276-2.353-2.678-2.353-1.317 0-2.652.681-2.79 2.28zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/>
    </svg>
  </span>`;
}

function labelWithHelp(forId: string, text: string, help: string): string {
  return `<label class="form-label" for="${forId}">${escapeHtml(text)}${helpIcon(help)}</label>`;
}

export function renderLoginPage(notice?: Notice): string {
  const noticeHtml = notice
    ? `<div class="alert alert-${notice.type} py-2" role="alert">${escapeHtml(notice.message)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  ${bootstrapHead("Sign in — Executor")}
</head>
<body class="bg-body-tertiary">
  <div class="container d-flex align-items-center justify-content-center" style="min-height: 100vh;">
    <div class="card shadow-sm" style="width: 100%; max-width: 22rem;">
      <div class="card-body p-4">
        <h1 class="h4 mb-3 text-center">Executor</h1>
        ${noticeHtml}
        <form method="post" action="/admin/login">
          <div class="mb-3">
            <label class="form-label" for="username">Username</label>
            <input class="form-control" id="username" name="username" autocomplete="username" required autofocus>
          </div>
          <div class="mb-3">
            <label class="form-label" for="password">Password</label>
            <input class="form-control" id="password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <div class="form-check mb-3">
            <input class="form-check-input" type="checkbox" id="remember" name="remember" value="true">
            <label class="form-check-label" for="remember">Remember me</label>
          </div>
          <button class="btn btn-primary w-100" type="submit">Sign in</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function layout(title: string, body: string, notice?: Notice, tradingPaused = false): string {
  const noticeHtml = notice
    ? `<div class="alert alert-${notice.type} alert-dismissible fade show" role="alert">
        ${escapeHtml(notice.message)}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>`
    : "";

  const tradingBadge = tradingPaused
    ? `<span class="badge text-bg-warning">Trading stopped</span>`
    : `<span class="badge text-bg-success">Trading running</span>`;
  const tradingAction = tradingPaused ? "resume" : "stop";
  const tradingButtonClass = tradingPaused ? "btn-success" : "btn-danger";
  const tradingButtonLabel = tradingPaused ? "Resume" : "Stop";
  const tradingConfirm = tradingPaused
    ? ""
    : ` onsubmit="return confirm('Stop opening new trades? The bot and admin keep running, no new positions will be opened until you resume.');"`;

  return `<!doctype html>
<html lang="en">
<head>
  ${bootstrapHead(`Tradebot2 ${title}`)}
</head>
<body class="bg-body-tertiary">
  <nav class="navbar navbar-expand-lg bg-dark navbar-dark">
    <div class="container">
      <a class="navbar-brand" href="/admin/settings">Executor</a>
      <ul class="navbar-nav ms-auto flex-row align-items-center gap-2">
        <li class="nav-item">
          ${tradingBadge}
        </li>
        <li class="nav-item">
          <form method="post" action="/admin/trading" class="d-inline"${tradingConfirm}>
            <input type="hidden" name="action" value="${tradingAction}">
            <button class="btn btn-sm ${tradingButtonClass}" type="submit">${tradingButtonLabel}</button>
          </form>
        </li>
        <li class="nav-item">
          <form method="post" action="/admin/logout" class="d-inline">
            <button class="btn btn-outline-light btn-sm" type="submit">Sign out</button>
          </form>
        </li>
      </ul>
    </div>
  </nav>
  <main class="container py-4">
    ${noticeHtml}
    ${body}
  </main>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => new bootstrap.Tooltip(el));
  </script>
</body>
</html>`;
}

export function renderRestartingPage(noticeKind: string, tradingPaused = false): string {
  const noticeParam = noticeKind ? `${encodeURIComponent(noticeKind)}=1` : "";
  const returnUrl = `/admin/settings${noticeParam ? `?${noticeParam}` : ""}`;
  const restartUrl = `/admin/restart`;
  const healthUrl = `/admin/health`;

  const body = `
<div class="text-center py-5">
  <div class="spinner-border text-primary mb-3" role="status">
    <span class="visually-hidden">Restarting...</span>
  </div>
  <h1 class="h4">Restarting bot</h1>
  <p class="text-secondary mb-0" id="restart-status">Save complete. Restarting process...</p>
  <a class="btn btn-outline-secondary btn-sm mt-3" href="${returnUrl}">Back to settings now</a>
</div>
<script>
(async () => {
  const status = document.getElementById("restart-status");
  const restartUrl = ${JSON.stringify(restartUrl)};
  const healthUrl = ${JSON.stringify(healthUrl)};
  const returnUrl = ${JSON.stringify(returnUrl)};

  try {
    await fetch(restartUrl, { method: "POST" });
  } catch (_) {}

  for (let i = 0; i < 60; i++) {
    status.textContent = "Waiting for bot to start... (" + (i + 1) + "s)";
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch(healthUrl + "?t=" + Date.now(), { cache: "no-store" });
      if (response.ok) {
        window.location.href = returnUrl;
        return;
      }
    } catch (_) {}
  }

  status.textContent = "Restart is taking longer than expected. Refresh the page or return to settings manually.";
  status.insertAdjacentHTML("afterend", '<a class="btn btn-primary mt-3" href="' + returnUrl + '">Back to settings</a>');
})();
</script>`;

  return layout("Restart", body, undefined, tradingPaused);
}

export function renderSettingsPage(env: LoadedEnv, notice?: Notice, tradingPaused = false): string {
  const values = env.values;
  const apiKeyHelp = env.bybitApiKeySet ? "Key saved. Leave the field empty to keep the current value." : "Key not set.";
  const apiSecretHelp = env.bybitApiSecretSet
    ? "Secret saved. Leave the field empty to keep the current value."
    : "Secret not set.";

  const body = `
<div class="mb-3">
  <h1 class="h3 mb-1">Settings</h1>
  <p class="text-secondary mb-0">Restart the bot process after saving to apply changes.</p>
</div>
<div class="card shadow-sm">
  <div class="card-body">
    <form method="post" action="/admin/settings">
      <h2 class="h6 text-uppercase text-secondary">Trading</h2>
      <div class="row g-3">
        <div class="col-md-6">
          ${labelWithHelp("minLiquidationUsdt", "Min liquidation USDT", "Incoming signals below this liquidation size are ignored.")}
          <input class="form-control" id="minLiquidationUsdt" name="minLiquidationUsdt" value="${escapeHtml(values.minLiquidationUsdt)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("positionSizeUsdt", "Position size USDT", "Notional size of each opened position, in USDT.")}
          <input class="form-control" id="positionSizeUsdt" name="positionSizeUsdt" value="${escapeHtml(values.positionSizeUsdt)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("entryOrderType", "Entry order type", "Market opens the position immediately at the best available price (fastest, pays taker fee — recommended for this fast-moving liquidation-cascade strategy). Limit places a passive post-only order at the best bid/ask and reprices it to chase the book, avoiding taker fees. There is no timeout or market fallback: it waits until fully filled, however long that takes, so entries can be delayed by seconds to minutes compared to market.")}
          <select class="form-select" id="entryOrderType" name="entryOrderType">
            <option value="market" ${values.entryOrderType === "market" ? "selected" : ""}>Market (default)</option>
            <option value="limit" ${values.entryOrderType === "limit" ? "selected" : ""}>Limit (post-only chase, waits until filled)</option>
          </select>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("maxPositionsPer10Min", "Max positions per 10 min", "Caps how many new positions can be opened within any rolling 10-minute window.")}
          <input class="form-control" id="maxPositionsPer10Min" name="maxPositionsPer10Min" value="${escapeHtml(values.maxPositionsPer10Min)}" inputmode="numeric" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("direction", "Direction", "Which liquidation-cascade signals to trade. Signals in the other direction are logged but ignored.")}
          <select class="form-select" id="direction" name="direction">
            <option value="both" ${values.direction === "both" ? "selected" : ""}>Both (long & short)</option>
            <option value="long" ${values.direction === "long" ? "selected" : ""}>Long only</option>
            <option value="short" ${values.direction === "short" ? "selected" : ""}>Short only</option>
          </select>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("stopLossPercent", "Stop loss %", "Distance from entry price to the stop-loss order, in percent. Leave empty to disable stop-loss.")}
          <input class="form-control" id="stopLossPercent" name="stopLossPercent" value="${escapeHtml(values.stopLossPercent)}" inputmode="decimal" placeholder="empty = disabled">
        </div>
        <div class="col-md-6">
          ${labelWithHelp("stopLossOrderType", "Stop loss order type", "Market places the stop-loss as a market order (guaranteed fill, higher taker fee). Limit places a limit order at the configured stop-loss % to save on fees, plus an independent backup market stop-loss 10% further out (e.g. 2.2% if the main one is 2%) in case the limit order never fills during a fast move.")}
          <select class="form-select" id="stopLossOrderType" name="stopLossOrderType">
            <option value="market" ${values.stopLossOrderType === "market" ? "selected" : ""}>Market (default)</option>
            <option value="limit" ${values.stopLossOrderType === "limit" ? "selected" : ""}>Limit + backup market SL</option>
          </select>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("takeProfitPercent", "Take profit %", "Distance from entry price to the take-profit order, in percent. Leave empty to disable take-profit.")}
          <input class="form-control" id="takeProfitPercent" name="takeProfitPercent" value="${escapeHtml(values.takeProfitPercent)}" inputmode="decimal" placeholder="empty = disabled">
        </div>
      </div>
      <hr class="my-4">
      <h2 class="h6 text-uppercase text-secondary">Breakeven stop</h2>
      <div class="row g-3">
        <div class="col-12">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="breakevenEnabled" name="breakevenEnabled" value="true" ${values.breakevenEnabled ? "checked" : ""}>
            <label class="form-check-label" for="breakevenEnabled">Enable breakeven stop${helpIcon("When on, a background monitor watches every open position and moves its stop-loss to breakeven (entry price adjusted for round-trip taker fee, plus the extra profit % below) once the position is at least the trigger % in profit. The stop is placed as a Limit order to save on fees, plus an independent backup market stop-loss slightly further out in case the limit order doesn't fill during a fast move. It runs on a timer while any position is open and stops itself when none are — no action if all positions are closed.")}</label>
          </div>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("breakevenTriggerPercent", "Trigger %", "Minimum unrealized profit (in percent from entry price) a position must reach before its stop-loss is moved to breakeven.")}
          <input class="form-control" id="breakevenTriggerPercent" name="breakevenTriggerPercent" value="${escapeHtml(values.breakevenTriggerPercent)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("breakevenExtraProfitPercent", "Extra profit %", "Small guaranteed profit (in percent from entry price) added on top of the fee-adjusted breakeven price, so the position closes with a small gain instead of landing at zero or slightly negative once real fees/slippage are accounted for. 0 disables the extra margin.")}
          <input class="form-control" id="breakevenExtraProfitPercent" name="breakevenExtraProfitPercent" value="${escapeHtml(values.breakevenExtraProfitPercent)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("breakevenCheckIntervalSec", "Check interval (sec)", "How often, in seconds, the background monitor re-checks open positions for the breakeven condition.")}
          <input class="form-control" id="breakevenCheckIntervalSec" name="breakevenCheckIntervalSec" value="${escapeHtml(values.breakevenCheckIntervalSec)}" inputmode="numeric" required>
        </div>
      </div>
      <hr class="my-4">
      <h2 class="h6 text-uppercase text-secondary">Trailing stop</h2>
      <div class="row g-3">
        <div class="col-12">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="trailingEnabled" name="trailingEnabled" value="true" ${values.trailingEnabled ? "checked" : ""}>
            <label class="form-check-label" for="trailingEnabled">Enable trailing stop${helpIcon("When on, a background monitor watches every open position and, once it's at least Trigger % in profit, keeps pulling its stop-loss up (long) / down (short) to stay Stop distance % behind the current price. The stop only ever moves in the profitable direction — if price pulls back against the position, the stop is left where it is. Placed as a Limit order to save on fees, plus an independent backup market stop-loss slightly further out in case the limit order doesn't fill during a fast move. Runs independently of (and alongside) the breakeven stop above — both only ever tighten the stop, never loosen it, so whichever has moved it furthest simply wins. It runs on a timer while any position is open and stops itself when none are.")}</label>
          </div>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("trailingTriggerPercent", "Trigger %", "Minimum unrealized profit (in percent from entry price) a position must reach before trailing starts adjusting its stop-loss. Must be lower than Take profit % above (if set) — otherwise take profit closes the position before trailing ever gets a chance to activate.")}
          <input class="form-control" id="trailingTriggerPercent" name="trailingTriggerPercent" value="${escapeHtml(values.trailingTriggerPercent)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("trailingStopPercent", "Stop distance %", "How far behind the current price (in percent) the trailing stop-loss is kept once trailing is active.")}
          <input class="form-control" id="trailingStopPercent" name="trailingStopPercent" value="${escapeHtml(values.trailingStopPercent)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("trailingCheckIntervalSec", "Check interval (sec)", "How often, in seconds, the background monitor re-checks open positions and tightens the trailing stop if price has moved further into profit.")}
          <input class="form-control" id="trailingCheckIntervalSec" name="trailingCheckIntervalSec" value="${escapeHtml(values.trailingCheckIntervalSec)}" inputmode="numeric" required>
        </div>
      </div>
      <hr class="my-4">
      <h2 class="h6 text-uppercase text-secondary">Bybit API</h2>
      <div class="mb-3">
        ${labelWithHelp("bybitApiKey", "BYBIT_API_KEY", "API key for your Bybit account, used to place and manage orders.")}
        <input class="form-control" id="bybitApiKey" name="bybitApiKey" type="password" autocomplete="new-password" placeholder="New API key">
        <div class="form-text">${escapeHtml(apiKeyHelp)}</div>
        <div class="form-check mt-2">
          <input class="form-check-input" type="checkbox" id="bybitApiKeyClear" name="bybitApiKeyClear" value="true">
          <label class="form-check-label" for="bybitApiKeyClear">Explicitly clear key</label>
        </div>
      </div>
      <div class="mb-3">
        ${labelWithHelp("bybitApiSecret", "BYBIT_API_SECRET", "API secret paired with the API key above. Never shown once saved.")}
        <input class="form-control" id="bybitApiSecret" name="bybitApiSecret" type="password" autocomplete="new-password" placeholder="New API secret">
        <div class="form-text">${escapeHtml(apiSecretHelp)}</div>
        <div class="form-check mt-2">
          <input class="form-check-input" type="checkbox" id="bybitApiSecretClear" name="bybitApiSecretClear" value="true">
          <label class="form-check-label" for="bybitApiSecretClear">Explicitly clear secret</label>
        </div>
      </div>
      <div class="mb-3">
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" role="switch" id="bybitTestnet" name="bybitTestnet" value="true" ${values.bybitTestnet ? "checked" : ""}>
          <label class="form-check-label" for="bybitTestnet">Bybit testnet${helpIcon("When on, orders are placed on Bybit testnet instead of the live exchange.")}</label>
        </div>
      </div>
      <hr class="my-4">
      <h2 class="h6 text-uppercase text-secondary">Server</h2>
      <div class="row g-3">
        <div class="col-md-6">
          ${labelWithHelp("serverHost", "Host", "Local address the executor's HTTP server binds to and listens on.")}
          <input class="form-control" id="serverHost" name="serverHost" value="${escapeHtml(values.serverHost)}" required>
        </div>
        <div class="col-md-6">
          ${labelWithHelp("serverPort", "Port", "Port the executor's HTTP server listens on. Changing this also requires updating EXECUTOR_URL in whatever sends signals here.")}
          <input class="form-control" id="serverPort" name="serverPort" value="${escapeHtml(values.serverPort)}" inputmode="numeric" required>
        </div>
      </div>
      <div class="alert alert-warning mt-4 mb-3">
        Changes take effect only after restarting the bot process.
      </div>
      <div class="d-flex justify-content-end">
        <button class="btn btn-success" type="submit">Save settings</button>
      </div>
    </form>
  </div>
</div>`;

  return layout("Settings", body, notice, tradingPaused);
}
