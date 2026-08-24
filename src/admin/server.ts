import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createSessionCookieValue,
  invalidateAllSessions,
  safeEqual,
  verifySessionCookieValue,
  SESSION_COOKIE_NAME,
  type AdminCredentials
} from "./auth";
import { loadEnv, saveEnv, type EnvFormValues } from "./config-store";
import { isTradingPaused, setTradingPaused } from "../tradingState";
import { renderLoginPage, renderRestartingPage, renderSettingsPage, type Notice } from "./views";

const MAX_BODY_BYTES = 1024 * 1024;

type AdminRoute = {
  section: "" | "settings" | "restart" | "restarting" | "health" | "login" | "logout" | "trading";
};

function setSecurityHeaders(res: ServerResponse, contentType = "text/html; charset=utf-8"): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function send(res: ServerResponse, statusCode: number, content: string, contentType?: string): void {
  res.statusCode = statusCode;
  setSecurityHeaders(res, contentType);
  res.end(content);
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader("Location", location);
  setSecurityHeaders(res, "text/plain; charset=utf-8");
  res.end("Redirecting");
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) {
    return true;
  }
  const proto = req.headers["x-forwarded-proto"];
  const value = Array.isArray(proto) ? proto[0] : proto;
  return value?.split(",")[0]?.trim() === "https";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

function setSessionCookie(res: ServerResponse, req: IncomingMessage, value: string, maxAgeSeconds?: number): void {
  const parts = [`${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`, "Path=/admin", "HttpOnly", "SameSite=Lax"];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  if (maxAgeSeconds) {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: ServerResponse, req: IncomingMessage): void {
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/admin", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function parseAdminRoute(pathname: string): AdminRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "admin") {
    return null;
  }

  const section = (parts[1] ?? "") as AdminRoute["section"];
  if (
    parts.length > 2 ||
    (section !== "" &&
      section !== "settings" &&
      section !== "restart" &&
      section !== "restarting" &&
      section !== "health" &&
      section !== "login" &&
      section !== "logout" &&
      section !== "trading")
  ) {
    return null;
  }

  return { section };
}

function successNotice(url: URL): Notice | undefined {
  if (url.searchParams.get("restarted") === "1") {
    return { type: "success", message: "Bot restarted." };
  }

  if (url.searchParams.get("trading") === "stopped") {
    return { type: "success", message: "Trading stopped. New signals will be rejected until you resume." };
  }

  if (url.searchParams.get("trading") === "resumed") {
    return { type: "success", message: "Trading resumed." };
  }

  if (url.searchParams.get("saved") !== "1") {
    return undefined;
  }

  return { type: "success", message: "Settings saved. Bot restarted." };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Form size exceeds 1 MB");
    }
    chunks.push(buffer);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function envFromForm(form: URLSearchParams): EnvFormValues {
  return {
    bybitApiKey: form.get("bybitApiKey") ?? "",
    bybitApiKeyClear: form.get("bybitApiKeyClear") === "true",
    bybitApiSecret: form.get("bybitApiSecret") ?? "",
    bybitApiSecretClear: form.get("bybitApiSecretClear") === "true",
    bybitTestnet: form.get("bybitTestnet") === "true",
    serverHost: form.get("serverHost") ?? "",
    serverPort: form.get("serverPort") ?? "",
    minLiquidationUsdt: form.get("minLiquidationUsdt") ?? "",
    positionSizeUsdt: form.get("positionSizeUsdt") ?? "",
    entryOrderType: form.get("entryOrderType") ?? "market",
    stopLossPercent: form.get("stopLossPercent") ?? "",
    stopLossOrderType: form.get("stopLossOrderType") ?? "market",
    takeProfitPercent: form.get("takeProfitPercent") ?? "",
    maxPositionsPer10Min: form.get("maxPositionsPer10Min") ?? "",
    direction: form.get("direction") ?? "both",
    breakevenEnabled: form.get("breakevenEnabled") === "true",
    breakevenTriggerPercent: form.get("breakevenTriggerPercent") ?? "",
    breakevenCheckIntervalSec: form.get("breakevenCheckIntervalSec") ?? ""
  };
}

async function handleLoginGet(res: ServerResponse, url: URL): Promise<void> {
  const notice: Notice | undefined =
    url.searchParams.get("expired") === "1"
      ? { type: "danger", message: "Session expired. Please sign in again." }
      : undefined;
  send(res, 200, renderLoginPage(notice));
}

async function handleLoginPost(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: AdminCredentials
): Promise<void> {
  const form = await readForm(req);
  const username = form.get("username");
  const password = form.get("password");
  const rememberMe = form.get("remember") === "true";

  if (!safeEqual(username, credentials.username) || !safeEqual(password, credentials.password)) {
    send(res, 401, renderLoginPage({ type: "danger", message: "Invalid username or password." }));
    return;
  }

  const session = await createSessionCookieValue(credentials, rememberMe);
  setSessionCookie(res, req, session.value, session.maxAgeSeconds);
  redirect(res, "/admin/settings");
}

async function handleGet(res: ServerResponse, url: URL, route: AdminRoute): Promise<void> {
  if (route.section === "") {
    redirect(res, "/admin/settings");
    return;
  }

  if (route.section === "settings") {
    send(res, 200, renderSettingsPage(await loadEnv(), successNotice(url), isTradingPaused()));
    return;
  }

  if (route.section === "restarting") {
    const notice = url.searchParams.get("notice") ?? "";
    send(res, 200, renderRestartingPage(notice, isTradingPaused()));
    return;
  }

  if (route.section === "health") {
    send(res, 200, "ok", "text/plain; charset=utf-8");
    return;
  }

  send(res, 404, "Not found", "text/plain; charset=utf-8");
}

async function handlePost(req: IncomingMessage, res: ServerResponse, route: AdminRoute): Promise<void> {
  if (route.section !== "settings" && route.section !== "restart" && route.section !== "trading") {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }

  if (route.section === "trading") {
    const form = await readForm(req);
    const action = form.get("action");
    if (action !== "stop" && action !== "resume") {
      send(res, 400, "Invalid action", "text/plain; charset=utf-8");
      return;
    }
    setTradingPaused(action === "stop");
    console.warn(`admin ${action === "stop" ? "stopped" : "resumed"} trading`);
    redirect(res, `/admin/settings?trading=${action === "stop" ? "stopped" : "resumed"}`);
    return;
  }

  if (route.section === "restart") {
    send(
      res,
      200,
      "Restart command accepted. If the process runs under PM2, it will be started again.",
      "text/plain; charset=utf-8"
    );
    res.once("finish", () => {
      console.warn("admin requested application restart");
      setTimeout(() => process.exit(0), 100);
    });
    return;
  }

  const form = await readForm(req);
  await saveEnv(envFromForm(form));
  redirect(res, "/admin/restarting?notice=saved");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, credentials: AdminCredentials): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, "ok", "text/plain; charset=utf-8");
    return;
  }

  const route = parseAdminRoute(url.pathname);
  if (!route) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }

  if (route.section === "login") {
    if (req.method === "GET") {
      await handleLoginGet(res, url);
      return;
    }
    if (req.method === "POST") {
      await handleLoginPost(req, res, credentials);
      return;
    }
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }

  if (route.section === "logout") {
    if (req.method !== "POST") {
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }
    await invalidateAllSessions();
    clearSessionCookie(res, req);
    redirect(res, "/admin/login");
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const authenticated = await verifySessionCookieValue(cookies[SESSION_COOKIE_NAME], credentials);
  if (!authenticated) {
    if (req.method === "GET") {
      redirect(res, "/admin/login");
      return;
    }
    send(res, 401, renderLoginPage({ type: "danger", message: "Session expired. Please sign in again." }));
    return;
  }

  try {
    if (req.method === "GET") {
      await handleGet(res, url, route);
      return;
    }

    if (req.method === "POST") {
      await handlePost(req, res, route);
      return;
    }

    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (route.section === "restart") {
      send(res, 400, message, "text/plain; charset=utf-8");
      return;
    }
    const notice: Notice = { type: "danger", message };
    send(res, 400, renderSettingsPage(await loadEnv(), notice, isTradingPaused()));
  }
}

function readPort(): number {
  const raw = process.env.ADMIN_PORT ?? "3080";
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn(`invalid ADMIN_PORT=${raw}, using default`);
    return 3080;
  }
  return port;
}

export function startAdminServer(credentials: AdminCredentials): void {
  const host = process.env.ADMIN_HOST?.trim() || "127.0.0.1";
  const port = readPort();
  const server = createServer((req, res) => {
    void handleRequest(req, res, credentials).catch((error) => {
      console.error("admin ui request failed", error);
      send(res, 500, "Internal server error", "text/plain; charset=utf-8");
    });
  });

  server.listen(port, host, () => {
    console.log("admin ui started");
  });
}
