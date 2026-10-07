import type { LoadedEnv } from "./config-store";
import { I18N, type I18nKey } from "./i18n";

export type Notice = {
  type: "success" | "danger";
  message: string;
  /** Ключ перевода из I18N; без него показывается message как есть (например, ошибка валидации с бэкенда). */
  key?: I18nKey;
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** JSON для вставки внутрь <script>: экранируем "<", чтобы строка не могла закрыть тег. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Текст интерфейса: рендерится на английском, клиентский скрипт подменяет его по data-i18n при выборе RU. */
function tx(key: I18nKey): string {
  return `<span data-i18n="${key}">${escapeHtml(I18N.en[key])}</span>`;
}

function noticeText(notice: Notice): string {
  return notice.key ? tx(notice.key) : escapeHtml(notice.message);
}

const BASE_CSS = `
:root{--bg:#f5f6f7;--card:#fff;--border:#e3e5e8;--divider:#eceef0;--input:#d6d9de;--ink:#16191d;--secondary:#3a4048;--muted:#646b75;--faint:#8a919b;--accent:#2f8a5b;--accent-hover:#277a4f;--danger:#b2403d;--danger-2:#d0524f;--dark:#1c1f24}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:80px}
body{margin:0;background:var(--bg);font-family:'Ubuntu',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;overflow-x:hidden}
button,input,select{font-family:inherit}
a{color:#1f7a4d;text-decoration:none}a:hover{color:#155c39}
input::placeholder{color:#a0a6ae}
[hidden]{display:none !important}
.mono{font-family:'Ubuntu Mono',ui-monospace,monospace}
.lang{display:flex;gap:2px;padding:3px;background:#2a2e35;border-radius:8px;flex-shrink:0}
.lang button{height:26px;padding:0 9px;border:0;border-radius:6px;font:600 12px 'Ubuntu',sans-serif;letter-spacing:.04em;cursor:pointer;background:transparent;color:#9aa1ab}
.lang button.on{background:#fff;color:var(--ink)}
.inp{display:flex;align-items:center;height:38px;border:1px solid var(--input);border-radius:8px;padding:0 12px;gap:8px;background:#fff;min-width:0}
.inp:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(47,138,91,.15)}
.inp input,.inp select{flex:1;min-width:0;width:100%;border:0;outline:none;font:500 14px 'Ubuntu Mono',monospace;color:var(--ink);background:transparent;padding:0}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);width:min(680px,calc(100% - 32px));z-index:40;display:flex;align-items:center;gap:12px;padding:14px 18px;background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);font-size:14px}
.toast .dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.toast.danger{border-color:#f0cfce}.toast.danger .dot{background:var(--danger-2)}.toast.danger .toast-text{color:var(--danger)}
.toast-text{flex:1;min-width:0}
.toast-close{flex:0 0 auto;border:0;background:transparent;color:var(--faint);font-size:18px;line-height:1;cursor:pointer;padding:0 4px}
`;

function head(title: string, extraCss = ""): string {
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;700&family=Ubuntu+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>${BASE_CSS}${extraCss}</style>`;
}

function langSwitch(): string {
  return `<div class="lang" role="group" aria-label="Language">
    <button type="button" data-lang="en" class="on">EN</button>
    <button type="button" data-lang="ru">RU</button>
  </div>`;
}

/**
 * Общий клиентский i18n: выбор языка хранится в localStorage (executor-lang),
 * переводит [data-i18n] (текст), [data-i18n-ph] (placeholder), [data-i18n-title] (title)
 * и шлёт событие "langchange" для динамических строк страницы.
 */
function i18nScript(): string {
  return `<script>
(() => {
  const I18N = ${scriptJson(I18N)};
  const KEY = "executor-lang";
  let lang = "en";
  try { lang = localStorage.getItem(KEY) === "ru" ? "ru" : "en"; } catch (_) {}
  window.T = (key) => (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  window.getLang = () => lang;
  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = T(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = T(el.dataset.i18nPh); });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = T(el.dataset.i18nTitle); });
    document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
    document.dispatchEvent(new Event("langchange"));
  }
  window.setLang = (next) => {
    lang = next === "ru" ? "ru" : "en";
    try { localStorage.setItem(KEY, lang); } catch (_) {}
    apply();
  };
  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
  apply();
})();
</script>`;
}

const LOGIN_CSS = `
.login-wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;gap:16px}
.login-card{width:100%;max-width:360px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:28px 24px}
.login-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.login-top h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
.login-card .field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.login-card .field-label{font-size:13px;color:var(--secondary)}
.login-card .inp input{font:400 14px 'Ubuntu',sans-serif}
.check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--secondary);margin:4px 0 18px;cursor:pointer}
.check input{accent-color:var(--accent);width:16px;height:16px;margin:0}
.btn-primary{width:100%;height:40px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:500 14px 'Ubuntu',sans-serif;cursor:pointer}
.btn-primary:hover{background:var(--accent-hover)}
.alert{border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
.alert-danger{background:#fbeeee;color:var(--danger)}
.alert-success{background:#e8f4ee;color:#1f6b45}
`;

export function renderLoginPage(notice?: Notice): string {
  const noticeHtml = notice ? `<div class="alert alert-${notice.type}" role="alert">${noticeText(notice)}</div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  ${head("Sign in — Executor", LOGIN_CSS)}
</head>
<body>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-top">
        <h1>Executor</h1>
        ${langSwitch().replace('class="lang"', 'class="lang" style="background:#eef0f2"')}
      </div>
      ${noticeHtml}
      <form method="post" action="/admin/login">
        <div class="field">
          <label class="field-label" for="username">${tx("username")}</label>
          <div class="inp"><input id="username" name="username" autocomplete="username" required autofocus></div>
        </div>
        <div class="field">
          <label class="field-label" for="password">${tx("password")}</label>
          <div class="inp"><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        </div>
        <label class="check"><input type="checkbox" id="remember" name="remember" value="true">${tx("rememberMe")}</label>
        <button class="btn-primary" type="submit">${tx("signIn")}</button>
      </form>
    </div>
  </div>
  <style>.login-top .lang button{color:var(--muted)}.login-top .lang button.on{box-shadow:0 1px 2px rgba(0,0,0,.12)}</style>
  ${i18nScript()}
</body>
</html>`;
}

const LAYOUT_CSS = `
.hdr{position:sticky;top:0;z-index:20;background:var(--dark);color:#fff}
.hdr-in{max-width:1120px;margin:0 auto;padding:0 24px;height:56px;display:flex;align-items:center;gap:16px}
.logo{font-size:17px;font-weight:600;letter-spacing:-.01em;flex:1;min-width:0;color:#fff}
.logo:hover{color:#fff}
.pill{display:flex;align-items:center;gap:8px;font-size:13px;color:#c9f0d9;white-space:nowrap;flex-shrink:0;background:rgba(47,138,91,.22);padding:6px 12px;border-radius:999px}
.pill .dot{width:7px;height:7px;border-radius:50%;background:#45c27f}
.pill.paused{color:#f3dfa6;background:rgba(214,160,40,.2)}
.pill.paused .dot{background:#e0b030}
.hdr form{margin:0;display:flex;flex-shrink:0}
.hbtn{height:32px;padding:0 14px;white-space:nowrap;flex-shrink:0;border-radius:8px;border:1px solid #3a3f47;background:transparent;color:#d4d8dd;font:500 13px 'Ubuntu',sans-serif;cursor:pointer}
.hbtn:hover{background:#2a2e35}
.hbtn-stop{border-color:#5a2a2e;background:#3a1f22;color:#ffb4b4}
.hbtn-stop:hover{background:#4a2528}
.hbtn-resume{border-color:#2a5a3e;background:#1f3a2b;color:#b4f0cc}
.hbtn-resume:hover{background:#25452f}
@media (max-width:600px){
  .hdr-in{padding:0 12px;gap:6px}
  .hbtn{padding:0 9px}
  .logo{font-size:15px}
  .pill{padding:6px}
  .pill-text{display:none}
}
`;

function layout(title: string, body: string, notice?: Notice, tradingPaused = false, extraCss = "", script = ""): string {
  const statusKey: I18nKey = tradingPaused ? "tradingStopped" : "tradingRunning";
  const tradingAction = tradingPaused ? "resume" : "stop";
  const tradingButton = tradingPaused
    ? `<button class="hbtn hbtn-resume" type="submit">${tx("resumeBot")}</button>`
    : `<button class="hbtn hbtn-stop" type="submit">${tx("stopBot")}</button>`;
  const tradingConfirm = tradingPaused ? "" : ` data-confirm="confirmStop"`;

  // Уведомление сервера показываем тостом: успех исчезает сам, ошибка висит до закрытия.
  const noticeHtml = notice
    ? `<div class="toast${notice.type === "danger" ? " danger" : ""}" id="serverNotice" role="status" data-autohide="${notice.type === "success" ? "1" : "0"}">
        <span class="dot"></span><div class="toast-text">${noticeText(notice)}</div>
        <button type="button" class="toast-close" aria-label="Close" onclick="this.parentElement.remove()">×</button>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  ${head(`Executor — ${title}`, LAYOUT_CSS + extraCss)}
</head>
<body>
  <header class="hdr">
    <div class="hdr-in">
      <a class="logo" href="/admin/settings">Executor</a>
      ${langSwitch()}
      <div class="pill${tradingPaused ? " paused" : ""}" data-i18n-title="${statusKey}" title="${escapeHtml(I18N.en[statusKey])}">
        <span class="dot"></span><span class="pill-text">${tx(statusKey)}</span>
      </div>
      <form method="post" action="/admin/trading"${tradingConfirm}>
        <input type="hidden" name="action" value="${tradingAction}">
        ${tradingButton}
      </form>
      <form method="post" action="/admin/logout">
        <button class="hbtn" type="submit">${tx("signOut")}</button>
      </form>
    </div>
  </header>
  ${body}
  ${noticeHtml}
  ${i18nScript()}
  <script>
    document.querySelectorAll("form[data-confirm]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        if (!confirm(T(form.dataset.confirm))) event.preventDefault();
      });
    });
    const serverNotice = document.getElementById("serverNotice");
    if (serverNotice && serverNotice.dataset.autohide === "1") setTimeout(() => serverNotice.remove(), 3000);
  </script>
  ${script}
</body>
</html>`;
}

const RESTART_CSS = `
.restart{max-width:480px;margin:0 auto;padding:96px 24px;text-align:center}
.spinner{width:36px;height:36px;margin:0 auto 20px;border:3px solid #d6e9de;border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.restart h1{margin:0 0 8px;font-size:22px;font-weight:600;letter-spacing:-.01em}
.restart p{margin:0;color:var(--muted);font-size:14px}
.btn-outline{display:inline-flex;align-items:center;height:36px;margin-top:20px;padding:0 14px;border-radius:8px;border:1px solid var(--input);background:#fff;color:var(--ink);font:500 13px 'Ubuntu',sans-serif}
.btn-outline:hover{background:#f2f3f5;color:var(--ink)}
`;

/** Страница ожидания перезапуска — запасной путь, если форма отправлена без JS. */
export function renderRestartingPage(noticeKind: string, tradingPaused = false): string {
  const noticeParam = noticeKind ? `${encodeURIComponent(noticeKind)}=1` : "";
  const returnUrl = `/admin/settings${noticeParam ? `?${noticeParam}` : ""}`;

  const body = `
<div class="restart">
  <div class="spinner" role="status"></div>
  <h1>${tx("restartingTitle")}</h1>
  <p id="restart-status">${tx("restartSaved")}</p>
  <a class="btn-outline" id="restart-back" href="${escapeHtml(returnUrl)}">${tx("backNow")}</a>
</div>`;

  const script = `<script>
(async () => {
  const status = document.getElementById("restart-status");
  const returnUrl = ${scriptJson(returnUrl)};
  try { await fetch("/admin/restart", { method: "POST" }); } catch (_) {}
  for (let i = 0; i < 60; i++) {
    status.textContent = T("waitingStart").replace("{n}", String(i + 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch("/admin/health?t=" + Date.now(), { cache: "no-store" });
      if (response.ok) { window.location.href = returnUrl; return; }
    } catch (_) {}
  }
  status.textContent = T("restartTooLong");
})();
</script>`;

  return layout("Restart", body, undefined, tradingPaused, RESTART_CSS, script);
}

const SETTINGS_CSS = `
.wrap{max-width:1120px;width:100%;margin:0 auto;padding:32px 24px 120px;display:flex;align-items:flex-start}
.main{flex:1;min-width:0;display:flex;flex-direction:column;gap:28px}
.page-title{margin:0;font-size:26px;font-weight:600;letter-spacing:-.02em}
.page-sub{margin:6px 0 0;font-size:14px;color:var(--muted)}
.sec{display:flex;flex-direction:column;gap:10px}
.sec-title{margin:0;font-size:15px;font-weight:600}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.card > * + *{border-top:1px solid var(--divider)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 32px;padding:16px 20px}
.row-text{flex:1 1 260px;min-width:0}
.row-label{font-size:14px;font-weight:500}
.row-desc{font-size:13px;color:var(--muted);margin-top:3px;text-wrap:pretty;line-height:1.45}
.row-ctl{flex:0 1 260px;min-width:0;display:flex;flex-direction:column;gap:6px}
.row-ctl.wide{flex:1 1 320px}
.row-sw{flex-wrap:nowrap;gap:16px}
.row-sw .row-text{flex:1}
.unit{font:12px 'Ubuntu Mono',monospace;color:var(--faint);flex:0 0 auto}
.pre{font-size:13px;color:var(--faint);flex:0 0 auto}
.inp.invalid{border-color:var(--danger-2)}
.inp.invalid:focus-within{box-shadow:0 0 0 3px rgba(208,82,79,.15)}
.err{font-size:13px;color:var(--danger)}
.hint{font-size:12px;color:var(--faint);line-height:1.45;text-wrap:pretty}
.seg{display:grid;gap:2px;padding:3px;background:#eef0f2;border-radius:9px}
.seg label{display:block;cursor:pointer}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg span{display:flex;align-items:center;justify-content:center;height:32px;border-radius:7px;font:500 13px 'Ubuntu',sans-serif;color:var(--muted);white-space:nowrap;padding:0 6px}
.seg input:checked + span{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.seg input:focus-visible + span{outline:2px solid var(--accent);outline-offset:1px}
.rate{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.rate .inp-count{flex:0 0 64px;padding:0 10px}
.rate .inp-count input{text-align:center}
.rate .inp-window{flex:1}
.exit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:18px 20px}
.exit-label{font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px}
.sq{width:8px;height:8px;border-radius:2px}
.inp-lg{height:42px}
.inp-lg input{font-size:16px}
.inp-lg .unit{font-size:13px}
.sf{display:flex;flex-direction:column;gap:6px;min-width:0}
.sf-label{font-size:13px;color:var(--secondary)}
.sub{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;padding:16px 20px 18px;background:#fafbfb}
.sw{position:relative;flex:0 0 auto;display:inline-flex;cursor:pointer}
.sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.sw-track{width:42px;height:24px;border-radius:999px;padding:3px;display:flex;background:#cfd3d8;transition:background .15s}
.sw-knob{width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.sw input:checked + .sw-track{background:var(--accent)}
.sw input:checked + .sw-track .sw-knob{transform:translateX(18px)}
.sw input:focus-visible + .sw-track{outline:2px solid var(--accent);outline-offset:2px}
.conv-ctl{display:flex;align-items:center;gap:12px}
.conv-ctl .inp{flex:1}
.cred{display:flex;align-items:center;gap:8px;justify-content:flex-end;min-height:36px}
.cred > .m{display:none}
.cred[data-mode="saved"] > .m-saved,.cred[data-mode="unset"] > .m-unset,.cred[data-mode="replace"] > .m-replace,.cred[data-mode="clear"] > .m-clear{display:flex}
.cred-state{flex:1;min-width:0;align-items:center;gap:8px;font-size:13px;color:var(--secondary)}
.cred-state.danger{color:var(--danger)}
.cred .inp{flex:1;height:36px}
.cred .inp input{font-weight:400}
.cdot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:0 0 auto}
.cdot.off{background:#cfd3d8}
.btn{height:32px;padding:0 12px;border-radius:7px;border:1px solid transparent;background:transparent;font:500 13px 'Ubuntu',sans-serif;color:var(--ink);cursor:pointer;white-space:nowrap;align-items:center}
.btn-o{border-color:var(--input);background:#fff}
.btn-o:hover{background:#f2f3f5}
.btn-red{color:var(--danger)}
.btn-red:hover{background:#fbeeee}
.btn-muted{color:var(--muted)}
.btn-muted:hover{background:#f2f3f5}
.srv-toggle{align-self:flex-start;display:flex;align-items:center;gap:8px;border:0;background:transparent;padding:0;font:600 15px 'Ubuntu',sans-serif;color:var(--ink);cursor:pointer}
.srv-meta{font:400 13px 'Ubuntu',sans-serif;color:var(--faint)}
.srv-toggle:hover .srv-meta{color:var(--accent)}
.srv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:18px 20px}
.bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);width:min(680px,calc(100% - 32px));z-index:30;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 18px;background:var(--dark);color:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.bar-label{flex:1;min-width:0;font-size:14px}
.bar-label.error{color:#ffb4b4}
.bar-btn{height:40px;padding:0 14px;border-radius:8px;border:1px solid #3a3f47;background:transparent;color:#d4d8dd;font:500 14px 'Ubuntu',sans-serif;cursor:pointer;white-space:nowrap}
.bar-btn:hover{background:#2a2e35}
.bar-save{border:0;background:var(--accent);color:#fff;padding:0 16px}
.bar-save:hover{background:var(--accent-hover)}
.bar-btn:disabled{opacity:.6;cursor:default}
.noscript-save{align-self:flex-end;height:40px;padding:0 16px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:500 14px 'Ubuntu',sans-serif}
@media (max-width:600px){
  .wrap{padding:20px 14px 120px}
  .row-ctl,.row-ctl.wide{flex:1 1 100%}
  .row-sw .row-text{flex:1}
  .cred{flex-wrap:wrap;justify-content:flex-start}
  .bar{flex-wrap:wrap;padding:12px}
  .bar-label{flex:1 1 100%;padding:0 4px}
  .bar-btn{flex:1 1 0;padding:0 8px}
}
`;

type Rule = "pos" | "nonneg" | "int" | "optpos" | "port" | "req";

type InputOptions = {
  rule: Rule;
  unit?: string;
  prefix?: I18nKey;
  mode?: "decimal" | "numeric" | "text";
  placeholder?: I18nKey;
  className?: string;
};

const SEC = `<span class="unit">${tx("sec")}</span>`;
const PCT = `<span class="unit">%</span>`;
const USDT = `<span class="unit">USDT</span>`;

function textInput(name: string, value: string, opts: InputOptions): string {
  const placeholder = opts.placeholder
    ? ` placeholder="${escapeHtml(I18N.en[opts.placeholder])}" data-i18n-ph="${opts.placeholder}"`
    : "";
  return `<label class="inp${opts.className ? ` ${opts.className}` : ""}">${opts.prefix ? `<span class="pre">${tx(opts.prefix)}</span>` : ""}<input id="${name}" name="${name}" value="${escapeHtml(value)}" inputmode="${opts.mode ?? "decimal"}" autocomplete="off" spellcheck="false" data-rule="${opts.rule}"${placeholder}>${opts.unit ?? ""}</label>`;
}

function errorSlot(name: string): string {
  return `<div class="err" data-err-for="${name}" hidden></div>`;
}

function settingRow(label: I18nKey, desc: I18nKey | null, control: string, ctlClass = ""): string {
  return `<div class="row">
    <div class="row-text"><div class="row-label">${tx(label)}</div>${desc ? `<div class="row-desc">${tx(desc)}</div>` : ""}</div>
    <div class="row-ctl${ctlClass ? ` ${ctlClass}` : ""}">${control}</div>
  </div>`;
}

function segmented(name: string, current: string, options: Array<[string, I18nKey]>): string {
  const items = options
    .map(
      ([value, key]) =>
        `<label><input type="radio" name="${name}" value="${value}"${current === value ? " checked" : ""}><span>${tx(key)}</span></label>`
    )
    .join("");
  return `<div class="seg" role="radiogroup" style="grid-template-columns:repeat(${options.length},1fr)">${items}</div>`;
}

function toggleSwitch(name: string, checked: boolean, label: I18nKey): string {
  return `<label class="sw"><input type="checkbox" role="switch" id="${name}" name="${name}" value="true"${checked ? " checked" : ""} aria-label="${escapeHtml(I18N.en[label])}"><span class="sw-track"><span class="sw-knob"></span></span></label>`;
}

function subField(label: I18nKey, name: string, value: string, opts: InputOptions, hint: I18nKey): string {
  return `<div class="sf">
    <div class="sf-label">${tx(label)}</div>
    ${textInput(name, value, opts)}
    ${errorSlot(name)}
    <div class="hint">${tx(hint)}</div>
  </div>`;
}

function featureBlock(name: string, checked: boolean, label: I18nKey, desc: I18nKey, fields: string): string {
  return `<div class="row row-sw">
    <div class="row-text"><div class="row-label">${tx(label)}</div><div class="row-desc">${tx(desc)}</div></div>
    ${toggleSwitch(name, checked, label)}
  </div>
  <div class="sub" data-show-if="${name}"${checked ? "" : " hidden"}>${fields}</div>`;
}

/**
 * API-ключ/секрет: saved/unset → replace (поле ввода) или clear (удалить при сохранении).
 * Пустое поле сохраняет текущее значение, скрытый *Clear=true — удаляет (как старый чекбокс).
 */
function credential(name: "bybitApiKey" | "bybitApiSecret", isSet: boolean): string {
  const isSecret = name === "bybitApiSecret";
  const mode = isSet ? "saved" : "unset";
  const placeholder: I18nKey = isSecret ? "phSecret" : "phKey";
  return `<div class="cred" data-cred="${name}" data-mode="${mode}" data-initial="${mode}">
    <div class="m m-saved cred-state mono"><span class="cdot"></span>${tx("savedMask")}</div>
    <div class="m m-unset cred-state"><span class="cdot off"></span>${tx("notSet")}</div>
    <label class="m m-replace inp"><input name="${name}" type="${isSecret ? "password" : "text"}" autocomplete="new-password" spellcheck="false" placeholder="${escapeHtml(I18N.en[placeholder])}" data-i18n-ph="${placeholder}"></label>
    <div class="m m-clear cred-state danger">${tx("willRemove")}</div>
    <input type="hidden" name="${name}Clear" value="true" disabled>
    <button type="button" class="m m-saved btn btn-o" data-act="replace">${tx("replace")}</button>
    <button type="button" class="m m-unset btn btn-o" data-act="replace">${tx("set")}</button>
    <button type="button" class="m m-saved btn btn-red" data-act="clear">${tx("remove")}</button>
    <button type="button" class="m m-replace btn btn-muted" data-act="cancel">${tx("cancel")}</button>
    <button type="button" class="m m-clear btn btn-o" data-act="cancel">${tx("undo")}</button>
  </div>`;
}

export function renderSettingsPage(env: LoadedEnv, notice?: Notice, tradingPaused = false): string {
  const values = env.values;

  const body = `
<div class="wrap">
  <form class="main" id="settingsForm" method="post" action="/admin/settings" novalidate>
    <div>
      <h1 class="page-title">${tx("title")}</h1>
      <p class="page-sub">${tx("subtitle")}</p>
    </div>

    <section class="sec" id="entry">
      <h2 class="sec-title">${tx("secEntry")}</h2>
      <div class="card">
        ${settingRow("posSize", "posSizeD", textInput("positionSizeUsdt", values.positionSizeUsdt, { rule: "pos", unit: USDT }) + errorSlot("positionSizeUsdt"))}
        ${settingRow("direction", "directionD", segmented("direction", values.direction, [["long", "long"], ["short", "short"], ["both", "both"]]))}
        ${settingRow("orderType", "orderTypeD", segmented("entryOrderType", values.entryOrderType, [["market", "market"], ["limit", "limit"]]))}
        ${settingRow("minLiq", "minLiqD", textInput("minLiquidationUsdt", values.minLiquidationUsdt, { rule: "pos", unit: USDT }) + errorSlot("minLiquidationUsdt"))}
        ${settingRow(
          "rate",
          "rateD",
          `<div class="rate">
            ${textInput("maxPositions", values.maxPositions, { rule: "int", mode: "numeric", className: "inp-count" })}
            <span>${tx("per")}</span>
            ${textInput("maxPositionsWindowSec", values.maxPositionsWindowSec, { rule: "int", mode: "numeric", unit: SEC, className: "inp-window" })}
          </div>
          ${errorSlot("maxPositions")}${errorSlot("maxPositionsWindowSec")}`
        )}
      </div>
    </section>

    <section class="sec" id="exit">
      <h2 class="sec-title">${tx("secExit")}</h2>
      <div class="card">
        <div class="exit-grid">
          <div class="sf">
            <div class="exit-label"><span class="sq" style="background:#d0524f"></span>${tx("sl")}</div>
            ${textInput("stopLossPercent", values.stopLossPercent, { rule: "optpos", unit: PCT, className: "inp-lg", placeholder: "phDisabled" })}
            ${errorSlot("stopLossPercent")}
            <div class="hint">${tx("slD")}</div>
          </div>
          <div class="sf">
            <div class="exit-label"><span class="sq" style="background:#2f8a5b"></span>${tx("tp")}</div>
            ${textInput("takeProfitPercent", values.takeProfitPercent, { rule: "optpos", unit: PCT, className: "inp-lg", placeholder: "phDisabled" })}
            ${errorSlot("takeProfitPercent")}
            <div class="hint">${tx("tpD")}</div>
          </div>
        </div>
        ${settingRow(
          "slOrder",
          "slOrderD",
          `<label class="inp" style="padding:0 8px"><select id="stopLossOrderType" name="stopLossOrderType" style="font:400 14px 'Ubuntu',sans-serif;cursor:pointer">
            <option value="limit"${values.stopLossOrderType === "limit" ? " selected" : ""} data-i18n="limitBackup">${escapeHtml(I18N.en.limitBackup)}</option>
            <option value="market"${values.stopLossOrderType === "market" ? " selected" : ""} data-i18n="market">${escapeHtml(I18N.en.market)}</option>
          </select></label>`
        )}
      </div>
    </section>

    <section class="sec" id="protection">
      <h2 class="sec-title">${tx("secProtection")}</h2>
      <div class="card">
        ${featureBlock(
          "breakevenEnabled",
          values.breakevenEnabled,
          "be",
          "beD",
          subField("triggerAt", "breakevenTriggerPercent", values.breakevenTriggerPercent, { rule: "pos", unit: PCT }, "beTrigD") +
            subField("lockExtra", "breakevenExtraProfitPercent", values.breakevenExtraProfitPercent, { rule: "nonneg", unit: PCT }, "beExtraD") +
            subField("checkEvery", "breakevenCheckIntervalSec", values.breakevenCheckIntervalSec, { rule: "int", mode: "numeric", unit: SEC }, "beIntD")
        )}
        ${featureBlock(
          "trailingEnabled",
          values.trailingEnabled,
          "tr",
          "trD",
          subField("triggerAt", "trailingTriggerPercent", values.trailingTriggerPercent, { rule: "pos", unit: PCT }, "trTrigD") +
            subField("stopDist", "trailingStopPercent", values.trailingStopPercent, { rule: "pos", unit: PCT }, "trDistD") +
            subField("checkEvery", "trailingCheckIntervalSec", values.trailingCheckIntervalSec, { rule: "int", mode: "numeric", unit: SEC }, "trIntD")
        )}
      </div>
    </section>

    <section class="sec" id="automation">
      <h2 class="sec-title">${tx("secBackground")}</h2>
      <div class="card">
        ${settingRow(
          "sync",
          "syncD",
          textInput("positionSyncCheckIntervalSec", values.positionSyncCheckIntervalSec, { rule: "int", mode: "numeric", prefix: "every", unit: SEC }) +
            errorSlot("positionSyncCheckIntervalSec")
        )}
        ${settingRow(
          "conv",
          "convD",
          `<div class="conv-ctl">
            ${toggleSwitch("marketTpSlConversionEnabled", values.marketTpSlConversionEnabled, "conv")}
            <div style="flex:1;min-width:0;display:flex" data-show-if="marketTpSlConversionEnabled"${values.marketTpSlConversionEnabled ? "" : " hidden"}>
              ${textInput("marketTpSlConversionCheckIntervalSec", values.marketTpSlConversionCheckIntervalSec, { rule: "int", mode: "numeric", prefix: "every", unit: SEC })}
            </div>
          </div>
          ${errorSlot("marketTpSlConversionCheckIntervalSec")}
          <div class="hint" data-show-if="marketTpSlConversionEnabled"${values.marketTpSlConversionEnabled ? "" : " hidden"}>${tx("convIntD")}</div>`
        )}
      </div>
    </section>

    <section class="sec" id="api">
      <h2 class="sec-title">${tx("secApi")}</h2>
      <div class="card">
        ${settingRow("apiKey", "apiKeyD", credential("bybitApiKey", env.bybitApiKeySet), "wide")}
        ${settingRow("apiSecret", "apiSecretD", credential("bybitApiSecret", env.bybitApiSecretSet), "wide")}
        <div class="row row-sw">
          <div class="row-text"><div class="row-label">${tx("testnet")}</div><div class="row-desc">${tx("testnetD")}</div></div>
          ${toggleSwitch("bybitTestnet", values.bybitTestnet, "testnet")}
        </div>
      </div>
    </section>

    <section class="sec" id="server">
      <button type="button" class="srv-toggle" id="serverToggle" aria-expanded="false" aria-controls="serverCard">
        ${tx("secServer")} <span class="srv-meta" id="serverMeta">${escapeHtml(`${values.serverHost}:${values.serverPort} · ${I18N.en.edit}`)}</span>
      </button>
      <div class="card" id="serverCard" hidden>
        <div class="srv-grid">
          ${subField("host", "serverHost", values.serverHost, { rule: "req", mode: "text" }, "hostD")}
          ${subField("port", "serverPort", values.serverPort, { rule: "port", mode: "numeric" }, "portD")}
        </div>
      </div>
    </section>

    <noscript><button class="noscript-save" type="submit">${tx("save")}</button></noscript>

    <div class="bar" id="saveBar" hidden>
      <div class="bar-label" id="barLabel"></div>
      <button type="button" class="bar-btn" id="discardBtn">${tx("discard")}</button>
      <button type="submit" class="bar-btn bar-save" id="saveBtn">${tx("save")}</button>
    </div>
  </form>
</div>
<div class="toast" id="toast" role="status" hidden><span class="dot"></span><div class="toast-text" id="toastText"></div></div>`;

  return layout("Settings", body, notice, tradingPaused, SETTINGS_CSS, `<script>${SETTINGS_SCRIPT}</script>`);
}

/** Клиентская логика страницы настроек: счётчик несохранённых изменений, валидация, сохранение + перезапуск. */
const SETTINGS_SCRIPT = `
(() => {
  const form = document.getElementById("settingsForm");
  const bar = document.getElementById("saveBar");
  const barLabel = document.getElementById("barLabel");
  const saveBtn = document.getElementById("saveBtn");
  const discardBtn = document.getElementById("discardBtn");
  const toast = document.getElementById("toast");
  const toastText = document.getElementById("toastText");
  const serverToggle = document.getElementById("serverToggle");
  const serverCard = document.getElementById("serverCard");
  const serverMeta = document.getElementById("serverMeta");
  const creds = Array.from(form.querySelectorAll(".cred"));
  let busy = false;
  let barError = "";
  let toastTimer = null;

  function credInput(cred) { return cred.querySelector('input[name="' + cred.dataset.cred + '"]'); }

  function setCredMode(cred, mode) {
    cred.dataset.mode = mode;
    cred.querySelector('input[name="' + cred.dataset.cred + 'Clear"]').disabled = mode !== "clear";
    if (mode !== "replace") credInput(cred).value = "";
  }

  creds.forEach((cred) => {
    cred.addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]");
      if (!act) return;
      const action = act.dataset.act;
      if (action === "replace") {
        setCredMode(cred, "replace");
        credInput(cred).focus();
      } else if (action === "clear") {
        setCredMode(cred, "clear");
      } else {
        setCredMode(cred, cred.dataset.initial);
      }
      refresh();
    });
  });

  function isChanged(el) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    if (el.tagName === "SELECT") return Array.from(el.options).some((o) => o.selected !== o.defaultSelected);
    return el.value !== el.defaultValue;
  }

  function changeCount() {
    const credNames = new Set();
    creds.forEach((cred) => { credNames.add(cred.dataset.cred); credNames.add(cred.dataset.cred + "Clear"); });
    const changedNames = new Set();
    Array.from(form.elements).forEach((el) => {
      if (!el.name || credNames.has(el.name) || el.type === "hidden") return;
      if (isChanged(el)) changedNames.add(el.name);
    });
    let n = changedNames.size;
    creds.forEach((cred) => {
      const mode = cred.dataset.mode;
      if (mode === "clear" || (mode === "replace" && credInput(cred).value.trim() !== "")) n++;
    });
    return n;
  }

  function syncVisibility() {
    form.querySelectorAll("[data-show-if]").forEach((el) => {
      const toggle = document.getElementById(el.dataset.showIf);
      el.hidden = !(toggle && toggle.checked) && !el.classList.contains("force-show");
    });
  }

  function updateServerMeta() {
    const open = !serverCard.hidden;
    serverToggle.setAttribute("aria-expanded", String(open));
    serverMeta.textContent = open
      ? T("hide")
      : form.elements.serverHost.value + ":" + form.elements.serverPort.value + " · " + T("edit");
  }

  function barText(n) {
    if (getLang() === "ru") return "Несохранённых изменений: " + n;
    return n === 1 ? "1 unsaved change" : n + " unsaved changes";
  }

  function refresh() {
    syncVisibility();
    updateServerMeta();
    const n = changeCount();
    bar.hidden = n === 0 && !busy;
    barLabel.classList.toggle("error", !!barError);
    barLabel.textContent = busy ? T("saving") : barError || barText(n);
    saveBtn.disabled = busy;
    discardBtn.disabled = busy;
  }

  const RULES = {
    pos: (v) => v !== "" && Number.isFinite(Number(v)) && Number(v) > 0,
    nonneg: (v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0,
    int: (v) => v !== "" && Number.isInteger(Number(v)) && Number(v) > 0,
    optpos: (v) => v === "" || (Number.isFinite(Number(v)) && Number(v) > 0),
    port: (v) => v !== "" && Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 65535,
    req: (v) => v !== "",
  };
  const RULE_ERRORS = { pos: "errPos", nonneg: "errNonneg", int: "errInt", optpos: "errPos", port: "errPort", req: "errReq" };

  function validate(input) {
    const rule = input.dataset.rule;
    const raw = input.value.trim();
    const normalized = rule === "req" ? raw : raw.replace(/[\\s_,]/g, "");
    const ok = RULES[rule](normalized);
    const slot = form.querySelector('[data-err-for="' + input.name + '"]');
    input.closest(".inp").classList.toggle("invalid", !ok);
    input.dataset.errKey = ok ? "" : RULE_ERRORS[rule];
    if (slot) {
      slot.hidden = ok;
      slot.textContent = ok ? "" : T(RULE_ERRORS[rule]);
    }
    return ok;
  }

  function validateAll() {
    let firstInvalid = null;
    form.querySelectorAll("input[data-rule]").forEach((input) => {
      if (!validate(input) && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) {
      // Поле может быть в свёрнутой панели (выключенная функция или раздел Server) — раскрываем её.
      const hiddenPanel = firstInvalid.closest("[data-show-if]");
      if (hiddenPanel && hiddenPanel.hidden) hiddenPanel.classList.add("force-show");
      if (serverCard.contains(firstInvalid)) serverCard.hidden = false;
      refresh();
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ block: "center" });
    }
    return !firstInvalid;
  }

  form.addEventListener("input", (event) => {
    barError = "";
    if (event.target.dataset && event.target.dataset.rule && event.target.dataset.errKey) validate(event.target);
    refresh();
  });
  form.addEventListener("change", (event) => {
    if (event.target.dataset && event.target.dataset.rule) validate(event.target);
    refresh();
  });

  serverToggle.addEventListener("click", () => { serverCard.hidden = !serverCard.hidden; refresh(); });

  discardBtn.addEventListener("click", () => {
    form.reset();
    creds.forEach((cred) => setCredMode(cred, cred.dataset.initial));
    form.querySelectorAll(".force-show").forEach((el) => el.classList.remove("force-show"));
    form.querySelectorAll("input[data-rule]").forEach((input) => {
      input.dataset.errKey = "";
      input.closest(".inp").classList.remove("invalid");
    });
    form.querySelectorAll("[data-err-for]").forEach((slot) => { slot.hidden = true; });
    barError = "";
    refresh();
  });

  function showToast(text, danger, autoHideMs) {
    document.getElementById("serverNotice")?.remove();
    clearTimeout(toastTimer);
    toast.classList.toggle("danger", !!danger);
    toastText.textContent = text;
    toast.hidden = false;
    if (autoHideMs) toastTimer = setTimeout(() => { toast.hidden = true; }, autoHideMs);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function restartAndReload() {
    try { await fetch("/admin/restart", { method: "POST" }); } catch (_) {}
    await sleep(1000);
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch("/admin/health?t=" + Date.now(), { cache: "no-store" });
        if (response.ok) { window.location.href = "/admin/settings?saved=1"; return; }
      } catch (_) {}
      await sleep(1000);
    }
    showToast(T("restartTooLong"), true);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    barError = "";
    if (!validateAll()) {
      barError = T("errFix");
      refresh();
      return;
    }
    busy = true;
    refresh();
    let response;
    let data = null;
    try {
      response = await fetch(form.action, {
        method: "POST",
        headers: { "X-Admin-Ajax": "1" },
        body: new URLSearchParams(new FormData(form)),
      });
      data = await response.json().catch(() => null);
    } catch (_) {
      busy = false;
      barError = T("networkError");
      refresh();
      return;
    }
    if (response.status === 401) { window.location.href = "/admin/login?expired=1"; return; }
    if (!response.ok || !data || !data.ok) {
      busy = false;
      barError = (data && data.error) || T("saveFailed");
      refresh();
      return;
    }
    bar.hidden = true;
    showToast(T("savedRestarting"));
    await restartAndReload();
  });

  document.addEventListener("langchange", () => {
    form.querySelectorAll("input[data-rule]").forEach((input) => {
      const slot = form.querySelector('[data-err-for="' + input.name + '"]');
      if (slot && input.dataset.errKey) slot.textContent = T(input.dataset.errKey);
    });
    refresh();
  });

  refresh();
})();
`;
