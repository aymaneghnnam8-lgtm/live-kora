import { bucket } from "./logic.js";

export function authorizedStream(stream) {
  const url = typeof stream === "string" ? stream : stream?.url;
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return null;
    return { url: parsed.href };
  } catch {
    return null;
  }
}

export function fingerprint(match) {
  return JSON.stringify({
    short: match?.status?.short || "",
    elapsed: match?.status?.elapsed ?? null,
    extra: match?.status?.extra ?? null,
    home: match?.goals?.home ?? null,
    away: match?.goals?.away ?? null,
    stream: authorizedStream(match?.stream)?.url || null,
  });
}

export function diffSnapshots(previousLive, nextLive) {
  const previous = new Map(previousLive.map((match) => [match.id, match]));
  const next = new Map(nextLive.map((match) => [match.id, match]));
  const created = [];
  const updated = [];
  const finished = [];

  for (const match of nextLive) {
    const old = previous.get(match.id);
    if (!old) created.push(match);
    else if (fingerprint(old) !== fingerprint(match)) updated.push(match);
  }
  for (const match of previousLive) {
    if (!next.has(match.id)) finished.push(match);
  }
  return { created, updated, finished };
}

export function classifySnapshot(previousLive, nextLive, confirmed = []) {
  const diff = diffSnapshots(previousLive, nextLive);
  const confirmedById = new Map(confirmed.map((match) => [match.id, match]));
  const live = [...nextLive];
  const updated = [...diff.updated];
  const finished = [];

  for (const match of diff.finished) {
    const fresh = confirmedById.get(match.id);
    if (fresh && bucket(fresh.status?.short) === "live") {
      live.push(fresh);
      if (fingerprint(match) !== fingerprint(fresh)) updated.push(fresh);
      continue;
    }
    if (fresh && bucket(fresh.status?.short) !== "live") {
      finished.push({ ...fresh, stream: authorizedStream(fresh.stream), ended: true });
      continue;
    }
    finished.push({ ...match, stream: null, ended: true });
  }

  return {
    live,
    created: diff.created,
    updated,
    finished,
  };
}
