import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, readCookie, sessionCookie } from "./admin-auth.js";
import { getBoard, getCompetition, getDay, getMatch, hasQuotaRoom, publicStatus, readFixture, syncLiveFixtures } from "./football.js";
import { parseLeague } from "./logic.js";
import { createMonitor } from "./monitor.js";
import { getNews } from "./news.js";
import { openStore } from "./store.js";
import { syncLive } from "./sync-live.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const envResult = dotenv.config({ path: envPath, override: true });

const app = express();
const port = Number(process.env.PORT || 4173);
const store = openStore(path.join(root, "data", "bot.sqlite"));
const auth = createAdminAuth();
const monitor = createMonitor({
  store,
  intervalMs: 60_000,
  sync: () => syncLive({
    readLive: syncLiveFixtures,
    readFixture,
    allowConfirm: hasQuotaRoom,
    store,
  }),
});
let latest = { warning: null, quota: null };

monitor.onSync((result) => {
  latest = { warning: result?.warning || null, quota: result?.quota || latest.quota };
});

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/api/status", (req, res) => {
  res.json(publicStatus());
});

app.get("/api/day", async (req, res) => {
  try {
    const board = await getDay({
      date: String(req.query.date || ""),
      league: parseLeague(req.query.league || "all"),
      force: req.query.refresh === "1",
    });
    res.json(board);
  } catch (error) {
    sendFailure(res, error);
  }
});

app.get("/api/news", async (req, res) => {
  try {
    res.json(await getNews());
  } catch (error) {
    sendFailure(res, error);
  }
});

app.get("/api/competitions/:id", async (req, res) => {
  if (!/^\d{1,8}$/.test(req.params.id)) {
    res.status(400).json({ error: "bad_request", message: "Competition id must be a number." });
    return;
  }
  try {
    res.json(await getCompetition(Number(req.params.id)));
  } catch (error) {
    sendFailure(res, error);
  }
});

app.get("/api/matches", async (req, res) => {
  const scope = ["live", "upcoming", "finished"].includes(req.query.scope) ? req.query.scope : "live";
  try {
    const board = await getBoard({
      scope,
      league: parseLeague(req.query.league),
      force: req.query.refresh === "1",
    });
    res.json(board);
  } catch (error) {
    sendFailure(res, error);
  }
});

app.get("/api/matches/:id", async (req, res) => {
  if (!/^\d{1,12}$/.test(req.query.id || req.params.id)) {
    res.status(400).json({ error: "bad_request", message: "Match id must be a number." });
    return;
  }
  try {
    const detail = await getMatch(req.params.id, req.query.refresh === "1");
    res.json(detail);
  } catch (error) {
    sendFailure(res, error);
  }
});

app.get("/api/live/snapshot", (req, res) => {
  res.json(publicSnapshot());
});

app.get("/api/live/feed", (req, res) => {
  openFeed(req, res, publicSnapshot);
});

app.use("/api/admin", express.json({ limit: "1kb" }));

app.post("/api/admin/login", (req, res) => {
  try {
    const id = auth.login(req.body?.token, req.socket.remoteAddress || "");
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    res.setHeader("Set-Cookie", sessionCookie(id, { secure }));
    res.json({ ok: true });
  } catch (error) {
    sendAdminError(res, error);
  }
});

app.post("/api/admin/logout", (req, res) => {
  auth.logout(readCookie(req.headers.cookie, "lk_admin"));
  res.setHeader("Set-Cookie", sessionCookie("", { maxAge: 0 }));
  res.json({ ok: true });
});

app.get("/api/admin/bot", requireAdmin, (req, res) => {
  res.json(adminStatus());
});

app.get("/api/admin/feed", requireAdmin, (req, res) => {
  openFeed(req, res, adminStatus);
});

app.post("/api/admin/bot/start", requireAdmin, (req, res) => {
  store.setDesired("running");
  monitor.startIfDesired();
  console.log(`[bot] ${new Date().toISOString()} start requested`);
  res.json(adminStatus());
});

app.post("/api/admin/bot/stop", requireAdmin, (req, res) => {
  monitor.stop();
  res.json(adminStatus());
});

app.post("/api/admin/bot/restart", requireAdmin, async (req, res) => {
  try {
    await monitor.restart();
    res.json(adminStatus());
  } catch (error) {
    sendFailure(res, error);
  }
});

app.get("/watch/:id", (req, res) => {
  if (!/^\d{1,12}$/.test(req.params.id)) {
    res.status(400).type("html").send("رقم المباراة غير صالح.");
    return;
  }
  res.sendFile(path.join(root, "public", "watch.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(root, "public", "admin.html"));
});

app.use(express.static(path.join(root, "public"), { index: "index.html" }));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found", message: "Unknown API route." });
});

function requireAdmin(req, res, next) {
  if (!auth.configured()) {
    res.status(503).json({ error: "admin_disabled", message: "Set ADMIN_TOKEN in the server .env file." });
    return;
  }
  if (!auth.valid(readCookie(req.headers.cookie, "lk_admin"))) {
    res.status(401).json({ error: "unauthorized", message: "Sign in required." });
    return;
  }
  next();
}

function publicSnapshot() {
  const last = store.recentRuns(10).find((run) => run.status === "ok") || null;
  return {
    fetchedAt: last?.finished_at || null,
    source: last?.source || null,
    warning: latest.warning,
    quota: latest.quota,
    matches: store.liveFixtures(),
    finished: store.recentFinished(50),
  };
}

function adminStatus() {
  const runs = store.recentRuns(10);
  return {
    desired: store.getState().desired,
    running: monitor.isRunning(),
    liveCount: store.liveFixtures().length,
    lastRun: runs[0] || null,
    runs,
    changes: store.recentChanges(20),
  };
}

function openFeed(req, res, snapshot) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const send = () => res.write(`event: sync\ndata: ${JSON.stringify(snapshot())}\n\n`);
  send();
  const unsubscribe = monitor.onSync(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  ping.unref?.();
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function sendAdminError(res, error) {
  const status = error.code === "admin_disabled" ? 503 : error.code === "rate_limited" ? 429 : 401;
  res.status(status).json({
    error: error.code || "unauthorized",
    message: error.message || "Sign in required.",
  });
}

function sendFailure(res, error) {
  const status = error.code === "missing_api_key"
    ? 503
    : error.code === "bad_request"
      ? 400
      : error.code === "not_found"
        ? 404
        : error.code === "rate_limited"
          ? 429
          : 502;
  res.status(status).json({
    error: error.code || "upstream",
    message: error.message || "The football API request failed.",
  });
}

const server = app.listen(port, () => {
  const keyReady = Boolean(process.env.API_FOOTBALL_KEY?.trim());
  console.log(`Live Kora running at http://localhost:${port}`);
  console.log(`Env file: ${envPath} (${envResult.error ? "not loaded" : "loaded"})`);
  console.log(`API_FOOTBALL_KEY configured: ${keyReady}`);
  console.log(`ADMIN_TOKEN configured: ${auth.configured()}`);
  monitor.startIfDesired();
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[bot] ${new Date().toISOString()} ${signal} received, releasing the lock`);
  monitor.release();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
