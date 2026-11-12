import fs from "node:fs";
import path from "node:path";

export function createCache(file) {
  const entries = new Map();
  let quota = { limit: null, remaining: null, updatedAt: null };

  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const entry of saved.entries || []) {
      entries.set(entry.key, entry);
    }
    if (saved.quota) quota = saved.quota;
  } catch {
    // First run, or the cache file is still empty.
  }

  function persist() {
    const payload = {
      quota,
      entries: [...entries.values()],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload));
    fs.renameSync(temporary, file);
  }

  return {
    getFresh(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) return null;
      return entry;
    },
    getAny(key) {
      return entries.get(key) || null;
    },
    set(key, value, ttlMs, now = Date.now()) {
      entries.set(key, {
        key,
        value,
        fetchedAt: now,
        expiresAt: now + ttlMs,
        ttlMs,
      });
      persist();
    },
    extend(key, ttlMs, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.expiresAt = now + ttlMs;
      entry.ttlMs = ttlMs;
      persist();
    },
    invalidate(key) {
      entries.delete(key);
      persist();
    },
    getQuota() {
      if (quota.updatedAt) {
        const savedDay = new Date(quota.updatedAt).toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        if (savedDay !== today) {
          quota = { limit: quota.limit, remaining: null, updatedAt: null };
        }
      }
      return { ...quota };
    },
    setQuota(next) {
      quota = { ...quota, ...next, updatedAt: Date.now() };
      persist();
    },
  };
}
