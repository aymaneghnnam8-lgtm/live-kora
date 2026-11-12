import { randomUUID } from "node:crypto";

const STALE_LOCK_MS = 45_000;

export function createMonitor({
  store,
  sync,
  intervalMs = 60_000,
  sleep = delay,
  log = defaultLog,
  owner = `${process.pid}:${randomUUID()}`,
  runOnStart = true,
}) {
  let timer = null;
  let heartbeat = null;
  let runningJob = null;
  let started = false;
  let stopped = false;
  const listeners = new Set();

  function emit(result) {
    for (const listener of listeners) listener(result);
  }

  async function runJob() {
    if (runningJob) return runningJob;
    let task;
    task = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (stopped) return null;
        const runId = store.beginRun(attempt);
        try {
          const result = await sync({ attempt });
          store.finishRun(runId, result);
          emit(result);
          log.info("sync finished", {
            attempt,
            source: result.source,
            created: result.created,
            updated: result.updated,
            finished: result.finished,
          });
          return result;
        } catch (error) {
          const message = safeMessage(error);
          store.failRun(runId, message);
          lastError = error;
          log.error("sync failed", { attempt, code: error.code || "error", message });
          const retry = attempt < 3 && !stopped && error.code !== "missing_api_key" && error.code !== "rate_limited";
          if (!retry) break;
          const wait = attempt === 1 ? 15_000 : 30_000;
          log.info("retry scheduled", { attempt, waitMs: wait });
          await sleep(wait);
        }
      }
      if (lastError) log.error("sync stopped retrying", { message: safeMessage(lastError) });
      return null;
    })().finally(() => {
      if (runningJob === task) runningJob = null;
    });
    runningJob = task;
    return task;
  }

  async function tick() {
    if (stopped) return null;
    if (!store.ownsLock(owner) && !store.acquireLock(owner, STALE_LOCK_MS)) {
      log.info("sync skipped because another bot holds the lock");
      return null;
    }
    store.heartbeat(owner);
    if (runningJob) {
      log.info("sync skipped because a job is already running");
      return runningJob;
    }
    return runJob();
  }

  function schedule(wait) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        log.error("scheduler tick failed", { message: safeMessage(error) });
      }
      schedule(intervalMs);
    }, wait);
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (!stopped && store.ownsLock(owner)) store.heartbeat(owner);
    }, 20_000);
    heartbeat.unref?.();
  }

  function startIfDesired() {
    if (store.getState().desired !== "running") {
      log.info("bot stayed stopped after startup");
      return false;
    }
    if (started) return false;
    const recovered = store.recoverInterrupted();
    if (recovered) log.info("marked interrupted sync runs as failed", { count: recovered });
    started = true;
    stopped = false;
    const locked = store.acquireLock(owner, STALE_LOCK_MS);
    if (!locked) log.error("another bot process holds the lock; this process will not sync until the lock is free");
    else log.info("bot started", { intervalMs });
    startHeartbeat();
    schedule(locked && runOnStart ? 0 : intervalMs);
    return true;
  }

  function clearSchedule() {
    clearTimeout(timer);
    clearInterval(heartbeat);
    timer = null;
    heartbeat = null;
  }

  function release() {
    stopped = true;
    started = false;
    clearSchedule();
    store.releaseLock(owner);
  }

  function stop() {
    store.setDesired("stopped");
    release();
    log.info("bot stopped");
  }

  async function restart() {
    store.setDesired("running");
    stopped = true;
    clearSchedule();
    const pending = runningJob;
    if (pending) await pending;
    started = false;
    stopped = false;
    startIfDesired();
    log.info("bot restarted");
  }

  return {
    startIfDesired,
    stop,
    restart,
    release,
    runOnce: tick,
    isRunning() {
      return started && !stopped && store.getState().desired === "running";
    },
    onSync(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLog() {
  return null;
}

defaultLog.info = (message, fields) => write("log", message, fields);
defaultLog.error = (message, fields) => write("error", message, fields);

function write(method, message, fields) {
  const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  console[method](`[bot] ${new Date().toISOString()} ${message}${suffix}`);
}

export function safeMessage(error) {
  return String(error?.message || "sync failed").replace(/x-apisports-key|api[_-]?key|authorization/gi, "redacted");
}
