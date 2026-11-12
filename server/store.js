import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authorizedStream } from "./diff.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  desired TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  heartbeat INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  source TEXT,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  finished_count INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL,
  payload TEXT NOT NULL,
  status_short TEXT,
  goals_home INTEGER,
  goals_away INTEGER,
  elapsed INTEGER,
  stream_url TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fixture_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fixture_changes_at ON fixture_changes (at DESC);
`;

export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  db.prepare(`
    INSERT INTO bot_state (id, desired, updated_at) VALUES (1, 'running', ?)
    ON CONFLICT(id) DO NOTHING
  `).run(Date.now());
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original error is the one the caller needs.
      }
      throw error;
    }
  }

  getState() {
    return this.db.prepare("SELECT desired, updated_at FROM bot_state WHERE id = 1").get();
  }

  setDesired(desired) {
    this.db.prepare("UPDATE bot_state SET desired = ?, updated_at = ? WHERE id = 1").run(desired, Date.now());
  }

  recoverInterrupted() {
    const result = this.db.prepare(`
      UPDATE sync_runs
      SET status = 'failed', finished_at = ?, error = 'interrupted by server restart'
      WHERE status = 'running'
    `).run(Date.now());
    return result.changes || 0;
  }

  acquireLock(owner, staleMs, alive = pidAlive) {
    const now = Date.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT owner, heartbeat FROM bot_lock WHERE id = 1").get();
      const held = row && row.owner !== owner && now - row.heartbeat < staleMs && alive(row.owner);
      if (held) return false;
      this.db.prepare(`
        INSERT INTO bot_lock (id, owner, heartbeat) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat = excluded.heartbeat
      `).run(owner, now);
      return this.db.prepare("SELECT owner FROM bot_lock WHERE id = 1").get()?.owner === owner;
    });
  }

  ownsLock(owner) {
    return this.db.prepare("SELECT owner FROM bot_lock WHERE id = 1").get()?.owner === owner;
  }

  heartbeat(owner) {
    this.db.prepare("UPDATE bot_lock SET heartbeat = ? WHERE id = 1 AND owner = ?").run(Date.now(), owner);
  }

  releaseLock(owner) {
    this.db.prepare("DELETE FROM bot_lock WHERE id = 1 AND owner = ?").run(owner);
  }

  beginRun(attempt) {
    const result = this.db.prepare(`
      INSERT INTO sync_runs (started_at, status, attempt) VALUES (?, 'running', ?)
    `).run(Date.now(), attempt);
    return Number(result.lastInsertRowid);
  }

  finishRun(id, result) {
    this.db.prepare(`
      UPDATE sync_runs
      SET finished_at = ?, status = 'ok', source = ?, created_count = ?, updated_count = ?, finished_count = ?, error = NULL
      WHERE id = ?
    `).run(
      Date.now(),
      result.source || null,
      count(result.created),
      count(result.updated),
      count(result.finished),
      id
    );
  }

  failRun(id, message) {
    this.db.prepare(`
      UPDATE sync_runs
      SET finished_at = ?, status = 'failed', error = ?
      WHERE id = ?
    `).run(Date.now(), message, id);
  }

  applySnapshot({ live, created, updated, finished, at = Date.now() }) {
    this.transaction(() => {
      for (const match of live) this.upsertFixture(match, "live", at);
      for (const match of finished) this.upsertFixture(match, "finished", at);
      this.insertChanges(created, "new", at);
      this.insertChanges(updated, "updated", at);
      this.insertChanges(finished, "finished", at);
    });
  }

  upsertFixture(match, phase, at) {
    const stream = phase === "live" ? authorizedStream(match.stream) : null;
    const existing = this.db.prepare("SELECT first_seen FROM fixtures WHERE id = ?").get(match.id);
    this.db.prepare(`
      INSERT INTO fixtures (
        id, phase, payload, status_short, goals_home, goals_away, elapsed, stream_url, first_seen, last_seen, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phase = excluded.phase,
        payload = excluded.payload,
        status_short = excluded.status_short,
        goals_home = excluded.goals_home,
        goals_away = excluded.goals_away,
        elapsed = excluded.elapsed,
        stream_url = excluded.stream_url,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `).run(
      match.id,
      phase,
      JSON.stringify({ ...match, stream }),
      match.status?.short || null,
      match.goals?.home ?? null,
      match.goals?.away ?? null,
      match.status?.elapsed ?? null,
      stream?.url || null,
      existing?.first_seen || at,
      at,
      at
    );
  }

  insertChanges(matches, kind, at) {
    const insert = this.db.prepare(`
      INSERT INTO fixture_changes (fixture_id, kind, summary, at) VALUES (?, ?, ?, ?)
    `);
    for (const match of matches) insert.run(match.id, kind, summary(match), at);
  }

  liveFixtures() {
    return this.db.prepare(`
      SELECT payload FROM fixtures WHERE phase = 'live' ORDER BY elapsed DESC, id ASC
    `).all().map((row) => JSON.parse(row.payload));
  }

  recentFinished(limit = 50) {
    return this.db.prepare(`
      SELECT payload FROM fixtures WHERE phase = 'finished' ORDER BY updated_at DESC LIMIT ?
    `).all(limit).map((row) => JSON.parse(row.payload));
  }

  recentRuns(limit = 20) {
    return this.db.prepare(`
      SELECT id, started_at, finished_at, status, source, created_count, updated_count, finished_count, attempt, error
      FROM sync_runs ORDER BY id DESC LIMIT ?
    `).all(limit);
  }

  recentChanges(limit = 30) {
    return this.db.prepare(`
      SELECT id, fixture_id, kind, summary, at FROM fixture_changes ORDER BY id DESC LIMIT ?
    `).all(limit);
  }
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function summary(match) {
  const minute = match.status?.elapsed == null
    ? ""
    : `${match.status.elapsed}${match.status.extra ? `+${match.status.extra}` : ""}'`;
  const score = match.goals?.home == null || match.goals?.away == null
    ? ""
    : `${match.goals.home}-${match.goals.away}`;
  const stream = authorizedStream(match.stream) ? "official stream" : "";
  return [match.status?.short, minute, score, stream].filter(Boolean).join(" ");
}

function pidAlive(owner) {
  const pid = Number(String(owner || "").split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
