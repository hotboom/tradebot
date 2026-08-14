import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type AdminCredentials = {
  username: string;
  password: string;
};

export const SESSION_COOKIE_NAME = "admin_session";
const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_EPOCH_PATH = join(process.cwd(), ".admin-session-epoch");

// Подпись сама по себе не отзывается — без него после logout украденная или
// сохранённая cookie продолжала бы работать до истечения срока. Epoch
// персистентно хранится на диске (переживает перезапуск процесса) и попадает
// в подписанный payload; logout перегенерирует его, мгновенно инвалидируя
// все ранее выданные сессии на всех устройствах.
let cachedEpoch: string | null = null;

async function getSessionEpoch(): Promise<string> {
  if (cachedEpoch) {
    return cachedEpoch;
  }

  try {
    const stored = (await fs.readFile(SESSION_EPOCH_PATH, "utf8")).trim();
    if (stored) {
      cachedEpoch = stored;
      return cachedEpoch;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  cachedEpoch = randomBytes(16).toString("hex");
  await fs.writeFile(SESSION_EPOCH_PATH, cachedEpoch, "utf8");
  return cachedEpoch;
}

export async function invalidateAllSessions(): Promise<void> {
  cachedEpoch = randomBytes(16).toString("hex");
  await fs.writeFile(SESSION_EPOCH_PATH, cachedEpoch, "utf8");
}

export function getAdminCredentials(): AdminCredentials | null {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD?.trim();
  return username && password ? { username, password } : null;
}

export function isAdminEnabled(): boolean {
  return process.env.ADMIN_ENABLED === "true";
}

export function safeEqual(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) {
    return false;
  }

  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function sign(payload: string, password: string): string {
  return createHmac("sha256", password).update(payload).digest("base64url");
}

// Подпись сессии ключуется паролем администратора: он стабилен между
// перезапусками процесса (в отличие от случайного ключа в памяти), а при
// смене пароля все выданные сессии автоматически становятся недействительными.
export async function createSessionCookieValue(
  credentials: AdminCredentials,
  rememberMe: boolean
): Promise<{ value: string; maxAgeSeconds?: number }> {
  const epoch = await getSessionEpoch();
  const exp = rememberMe ? Date.now() + REMEMBER_ME_TTL_MS : undefined;
  const payload = Buffer.from(JSON.stringify({ u: credentials.username, exp, e: epoch })).toString("base64url");
  const signature = sign(payload, credentials.password);

  return {
    value: `${payload}.${signature}`,
    maxAgeSeconds: rememberMe ? Math.floor(REMEMBER_ME_TTL_MS / 1000) : undefined
  };
}

export async function verifySessionCookieValue(
  token: string | undefined,
  credentials: AdminCredentials
): Promise<boolean> {
  if (!token) {
    return false;
  }

  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex === -1) {
    return false;
  }

  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (!safeEqual(signature, sign(payload, credentials.password))) {
    return false;
  }

  let parsed: { u?: unknown; exp?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  if (typeof parsed.exp === "number" && Date.now() > parsed.exp) {
    return false;
  }

  if (typeof parsed.e !== "string" || !safeEqual(parsed.e, await getSessionEpoch())) {
    return false;
  }

  return typeof parsed.u === "string" && safeEqual(parsed.u, credentials.username);
}
