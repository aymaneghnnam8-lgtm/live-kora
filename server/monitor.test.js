import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizedStream, classifySnapshot, fingerprint } from "./diff.js";
import { createMonitor } from "./monitor.js";
import { syncLive } from "./sync-live.js";
import { openStore } from "./store.js";
import { createAdminAuth, readCookie, sessionCookie } from "./admin-auth.js";

const silent = { info() {}, error() {} };

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-kora-"));
  return path.join(dir, "bot.sqlite");
}

function match(id, overrides = {}) {
  return {
    id,
    status: { short: "1H", elapsed: 10, extra: null, long: "First Half" },
    goals: { home: 0, away: 0 },
    score: { ht: null, ft: null, et: null, pen: null },
    stream: null,
    home: { id: 1, name: "Home", logo: null },
    away: { id: 2, name: "Away", logo: null },
    league: { id: 39, name: "Premier League" },
    ...overrides,
  };
}

test("authorized streams accept only https urls", () => {
  assert.equal(authorizedStream(null), null);
  assert.equal(authorizedStream({ url: "http://cdn.example/live.m3u8" }), null);
  assert.equal(authorizedStream({ url: "javascript:alert(1)" }), null);
  assert.deepEqual(authorizedStream({ url: "https://cdn.example/live.m3u8" }), {
    url: "https://cdn.example/live.m3u8",
  });
});

test("snapshot classification detects new, updated, and finished matches", () => {
  const previous = [match(1), match(2, { goals: { home: 1, away: 0 } })];
  const next = [
    match(2, { goals: { home: 2, away: 0 }, status: { short: "1H", elapsed: 20, extra: null } }),
    match(3),
  ];
  const decision = classifySnapshot(previous, next);
  assert.deepEqual(decision.created.map((item) => item.id), [3]);
  assert.deepEqual(decision.updated.map((item) => item.id), [2]);
  assert.deepEqual(decision.finished.map((item) => item.id), [1]);
  assert.equal(decision.finished[0].ended, true);
  assert.equal(decision.finished[0].status.short, "1H");
  assert.equal(decision.finished[0].stream, null);
});

test("a disappeared match stays live when the fixture check still says live", () => {
  const previous = [match(1)];
  const confirmed = [match(1, { status: { short: "2H", elapsed: 70, extra: null } })];
  const decision = classifySnapshot(previous, [], confirmed);
  assert.equal(decision.finished.length, 0);
  assert.equal(decision.live[0].status.short, "2H");
});

test("a confirmed full-time fixture is stored as finished", () => {
  const previous = [match(4)];
  const confirmed = [match(4, { status: { short: "FT", elapsed: 90, extra: null }, goals: { home: 1, away: 1 } })];
  const decision = classifySnapshot(previous, [], confirmed);
  assert.equal(decision.live.length, 0);
  assert.equal(decision.finished[0].status.short, "FT");
  assert.equal(decision.finished[0].ended, true);
});

test("store keeps https streams and rejects other urls", () => {
  const store = openStore(tempFile());
  store.applySnapshot({
    live: [
      match(5, { stream: { url: "https://cdn.example/a.m3u8" } }),
      match(6, { stream: { url: "http://cdn.example/b.m3u8" } }),
    ],
    created: [],
    updated: [],
    finished: [],
    at: 10,
  });
  const saved = new Map(store.liveFixtures().map((item) => [item.id, item]));
  assert.equal(saved.get(5).stream.url, "https://cdn.example/a.m3u8");
  assert.equal(saved.get(6).stream, null);
  store.close();
});

test("interrupted sync runs are failed on recovery", () => {
  const file = tempFile();
  const store = openStore(file);
  store.beginRun(1);
  store.close();
  const again = openStore(file);
  assert.equal(again.recoverInterrupted(), 1);
  assert.equal(again.recentRuns(1)[0].status, "failed");
  assert.equal(again.recentRuns(1)[0].error, "interrupted by server restart");
  again.close();
});

test("a dead process lock can be taken and a live lock cannot", () => {
  const store = openStore(tempFile());
  assert.equal(store.acquireLock("111:one", 45_000, () => true), true);
  assert.equal(store.acquireLock("222:two", 45_000, () => true), false);
  assert.equal(store.acquireLock("222:two", 45_000, () => false), true);
  assert.equal(store.ownsLock("222:two"), true);
  store.close();
});

test("only one sync job runs when two ticks overlap", async () => {
  const store = openStore(tempFile());
  let active = 0;
  let max = 0;
  let calls = 0;
  const monitor = createMonitor({
    store,
    runOnStart: false,
    intervalMs: 60_000,
    log: silent,
    sync: () => new Promise((resolve) => {
      calls += 1;
      active += 1;
      max = Math.max(max, active);
      setTimeout(() => {
        active -= 1;
        resolve({ source: "cache", created: 0, updated: 0, finished: 0, matches: [], finishedMatches: [] });
      }, 40);
    }),
  });
  monitor.startIfDesired();
  const first = monitor.runOnce();
  const second = monitor.runOnce();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(max, 1);
  monitor.stop();
  store.close();
});

test("a second monitor does not sync while the lock is held", async () => {
  const file = tempFile();
  const firstStore = openStore(file);
  const secondStore = openStore(file);
  let calls = 0;
  const sync = async () => {
    calls += 1;
    return { source: "cache", created: 1, updated: 0, finished: 0 };
  };
  const first = createMonitor({ store: firstStore, sync, runOnStart: false, intervalMs: 60_000, log: silent, owner: `${process.pid}:a` });
  const second = createMonitor({ store: secondStore, sync, runOnStart: false, intervalMs: 60_000, log: silent, owner: "99999999:b" });
  assert.equal(first.startIfDesired(), true);
  assert.equal(second.startIfDesired(), true);
  await first.runOnce();
  await second.runOnce();
  assert.equal(calls, 1);
  first.stop();
  second.stop();
  firstStore.close();
  secondStore.close();
});

test("failed sync jobs retry unless the failure is quota or a missing key", async () => {
  const store = openStore(tempFile());
  const waits = [];
  let calls = 0;
  const monitor = createMonitor({
    store,
    runOnStart: false,
    intervalMs: 60_000,
    log: silent,
    sleep: async (ms) => waits.push(ms),
    sync: async () => {
      calls += 1;
      const error = new Error("upstream failed");
      error.code = "upstream";
      throw error;
    },
  });
  monitor.startIfDesired();
  await monitor.runOnce();
  assert.equal(calls, 3);
  assert.deepEqual(waits, [15_000, 30_000]);
  assert.equal(store.recentRuns(5).filter((run) => run.status === "failed").length, 3);
  monitor.stop();
  store.close();
});

test("rate limited sync does not retry inside the same job", async () => {
  const store = openStore(tempFile());
  let calls = 0;
  const monitor = createMonitor({
    store,
    runOnStart: false,
    intervalMs: 60_000,
    log: silent,
    sleep: async () => { throw new Error("should not retry"); },
    sync: async () => {
      calls += 1;
      const error = new Error("API per-minute limit reached. Try again shortly.");
      error.code = "rate_limited";
      throw error;
    },
  });
  monitor.startIfDesired();
  await monitor.runOnce();
  assert.equal(calls, 1);
  monitor.stop();
  store.close();
});

test("a stopped bot stays stopped until start is requested", () => {
  const store = openStore(tempFile());
  store.setDesired("stopped");
  const monitor = createMonitor({
    store,
    runOnStart: true,
    intervalMs: 60_000,
    log: silent,
    sync: async () => { throw new Error("should not sync"); },
  });
  assert.equal(monitor.startIfDesired(), false);
  assert.equal(monitor.isRunning(), false);
  store.close();
});

test("sync run counts stay numeric when a result field is not a count", () => {
  const store = openStore(tempFile());
  const id = store.beginRun(1);
  store.finishRun(id, { source: "cache", created: 1, updated: 2, finished: [] });
  const run = store.recentRuns(1)[0];
  assert.equal(run.status, "ok");
  assert.equal(run.created_count, 1);
  assert.equal(run.updated_count, 2);
  assert.equal(run.finished_count, 0);
  store.close();
});

test("sync saves the snapshot and reports cache hits without inventing streams", async () => {
  const store = openStore(tempFile());
  const result = await syncLive({
    store,
    allowConfirm: () => false,
    readFixture: async () => { throw new Error("fixture lookup was not allowed"); },
    readLive: async () => ({
      cached: true,
      stale: false,
      fetchedAt: 50,
      quota: { remaining: 70, limit: 100 },
      matches: [
        match(7, { stream: { url: "https://cdn.example/live.m3u8" } }),
        match(8, { stream: { url: "http://cdn.example/live.m3u8" } }),
      ],
    }),
  });
  assert.equal(result.source, "cache");
  assert.equal(result.created, 2);
  assert.equal(result.finished, 0);
  assert.equal(result.matches[0].stream.url, "https://cdn.example/live.m3u8");
  assert.equal(result.matches[1].stream, null);
  assert.equal(store.liveFixtures().length, 2);
  assert.equal(fingerprint(store.liveFixtures()[0]) !== "", true);
  store.close();
});

test("admin authentication does not accept a missing or wrong token", () => {
  const auth = createAdminAuth({ ADMIN_TOKEN: "server-secret" });
  assert.equal(auth.configured(), true);
  assert.throws(() => auth.login("", "127.0.0.1"), /not accepted/);
  assert.throws(() => auth.login("wrong", "127.0.0.1"), /not accepted/);
  const id = auth.login("server-secret", "127.0.0.1");
  assert.equal(auth.valid(id), true);
  auth.logout(id);
  assert.equal(auth.valid(id), false);
  assert.equal(readCookie(sessionCookie(id), "lk_admin"), id);
  assert.equal(sessionCookie(id).includes("HttpOnly"), true);
  assert.equal(sessionCookie(id).includes("server-secret"), false);
});

test("admin sign-in is disabled when ADMIN_TOKEN is empty", () => {
  const auth = createAdminAuth({ ADMIN_TOKEN: "  " });
  assert.equal(auth.configured(), false);
  assert.throws(() => auth.login("anything", "127.0.0.1"), (error) => error.code === "admin_disabled");
});
