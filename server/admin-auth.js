import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function createAdminAuth(env = process.env) {
  const sessions = new Map();
  const attempts = new Map();

  function configured() {
    return token().length > 0;
  }

  function token() {
    return String(env.ADMIN_TOKEN || "").trim();
  }

  function matches(input) {
    const expected = token();
    if (!expected || typeof input !== "string" || !input) return false;
    const left = createHash("sha256").update(input).digest();
    const right = createHash("sha256").update(expected).digest();
    return timingSafeEqual(left, right);
  }

  function tooMany(ip, now) {
    const row = attempts.get(ip);
    if (!row || row.reset <= now) return false;
    return row.count >= MAX_ATTEMPTS;
  }

  function recordFailure(ip, now) {
    const row = attempts.get(ip);
    if (!row || row.reset <= now) attempts.set(ip, { count: 1, reset: now + WINDOW_MS });
    else row.count += 1;
  }

  function login(input, ip, now = Date.now()) {
    if (!configured()) {
      const error = new Error("Set ADMIN_TOKEN in the server .env file.");
      error.code = "admin_disabled";
      throw error;
    }
    if (tooMany(ip, now)) {
      const error = new Error("Too many sign-in attempts. Try again later.");
      error.code = "rate_limited";
      throw error;
    }
    if (!matches(input)) {
      recordFailure(ip, now);
      const error = new Error("The admin token was not accepted.");
      error.code = "unauthorized";
      throw error;
    }
    attempts.delete(ip);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, now + SESSION_MS);
    return id;
  }

  function valid(id, now = Date.now()) {
    if (!id || !sessions.has(id)) return false;
    if (sessions.get(id) <= now) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  function logout(id) {
    sessions.delete(id);
  }

  return { configured, login, valid, logout };
}

export function readCookie(header, name) {
  const source = String(header || "");
  for (const part of source.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

export function sessionCookie(id, { secure = false, maxAge = SESSION_MS / 1000 } = {}) {
  const parts = [`lk_admin=${id}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
