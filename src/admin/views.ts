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
  </style>`;
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

function layout(title: string, body: string, notice?: Notice): string {
  const noticeHtml = notice
    ? `<div class="alert alert-${notice.type} alert-dismissible fade show" role="alert">
        ${escapeHtml(notice.message)}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  ${bootstrapHead(title)}
</head>
<body class="bg-body-tertiary">
  <nav class="navbar navbar-expand-lg bg-dark navbar-dark">
    <div class="container">
      <a class="navbar-brand" href="/admin/settings">Executor</a>
      <ul class="navbar-nav ms-auto flex-row align-items-center gap-2">
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
</body>
</html>`;
}

export function renderRestartingPage(noticeKind: string): string {
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

  return layout("Restart", body);
}

export function renderSettingsPage(env: LoadedEnv, notice?: Notice): string {
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
      <h2 class="h6 text-uppercase text-secondary">Bybit API</h2>
      <div class="mb-3">
        <label class="form-label" for="bybitApiKey">BYBIT_API_KEY</label>
        <input class="form-control" id="bybitApiKey" name="bybitApiKey" type="password" autocomplete="new-password" placeholder="New API key">
        <div class="form-text">${escapeHtml(apiKeyHelp)}</div>
        <div class="form-check mt-2">
          <input class="form-check-input" type="checkbox" id="bybitApiKeyClear" name="bybitApiKeyClear" value="true">
          <label class="form-check-label" for="bybitApiKeyClear">Explicitly clear key</label>
        </div>
      </div>
      <div class="mb-3">
        <label class="form-label" for="bybitApiSecret">BYBIT_API_SECRET</label>
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
          <label class="form-check-label" for="bybitTestnet">Bybit testnet</label>
        </div>
        <div class="form-text">When on, orders are placed on Bybit testnet instead of the live exchange.</div>
      </div>
      <hr class="my-4">
      <h2 class="h6 text-uppercase text-secondary">Server</h2>
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label" for="serverHost">Host</label>
          <input class="form-control" id="serverHost" name="serverHost" value="${escapeHtml(values.serverHost)}" required>
        </div>
        <div class="col-md-6">
          <label class="form-label" for="serverPort">Port</label>
          <input class="form-control" id="serverPort" name="serverPort" value="${escapeHtml(values.serverPort)}" inputmode="numeric" required>
          <div class="form-text">Changing this also requires updating EXECUTOR_URL in whatever sends signals here.</div>
        </div>
      </div>
      <hr class="my-4">
      <h2 class="h6 text-uppercase text-secondary">Trading</h2>
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label" for="minLiquidationUsdt">Min liquidation USDT</label>
          <input class="form-control" id="minLiquidationUsdt" name="minLiquidationUsdt" value="${escapeHtml(values.minLiquidationUsdt)}" inputmode="decimal" required>
          <div class="form-text">Incoming signals below this liquidation size are ignored.</div>
        </div>
        <div class="col-md-6">
          <label class="form-label" for="positionSizeUsdt">Position size USDT</label>
          <input class="form-control" id="positionSizeUsdt" name="positionSizeUsdt" value="${escapeHtml(values.positionSizeUsdt)}" inputmode="decimal" required>
        </div>
        <div class="col-md-6">
          <label class="form-label" for="stopLossPercent">Stop loss %</label>
          <input class="form-control" id="stopLossPercent" name="stopLossPercent" value="${escapeHtml(values.stopLossPercent)}" inputmode="decimal" placeholder="empty = disabled">
        </div>
        <div class="col-md-6">
          <label class="form-label" for="takeProfitPercent">Take profit %</label>
          <input class="form-control" id="takeProfitPercent" name="takeProfitPercent" value="${escapeHtml(values.takeProfitPercent)}" inputmode="decimal" placeholder="empty = disabled">
        </div>
        <div class="col-md-6">
          <label class="form-label" for="maxPositionsPerHour">Max positions per hour</label>
          <input class="form-control" id="maxPositionsPerHour" name="maxPositionsPerHour" value="${escapeHtml(values.maxPositionsPerHour)}" inputmode="numeric" required>
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

  return layout("Settings", body, notice);
}
