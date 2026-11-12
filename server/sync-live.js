import { authorizedStream, classifySnapshot } from "./diff.js";

export async function syncLive({ readLive, readFixture, allowConfirm, store, now = () => Date.now() }) {
  const pack = await readLive();
  const next = (pack.matches || []).map(publicFixture);
  const decision = classifySnapshot(store.liveFixtures(), next, []);
  const confirmed = [];

  if (decision.finished.length && allowConfirm() && readFixture) {
    for (const match of decision.finished.slice(0, 2)) {
      try {
        const fixture = await readFixture(match.id);
        if (fixture?.match) confirmed.push(publicFixture(fixture.match));
      } catch (error) {
        if (error.code === "rate_limited" || error.code === "missing_api_key") break;
      }
    }
  }

  const finalDecision = confirmed.length
    ? classifySnapshot(store.liveFixtures(), next, confirmed)
    : decision;
  const at = now();
  store.applySnapshot({ ...finalDecision, at });
  return {
    source: pack.stale ? "stale" : pack.cached ? "cache" : "upstream",
    fetchedAt: pack.fetchedAt || at,
    created: finalDecision.created.length,
    updated: finalDecision.updated.length,
    finished: finalDecision.finished.length,
    warning: pack.warning || null,
    quota: pack.quota || null,
    matches: finalDecision.live.map(publicFixture),
    finishedMatches: finalDecision.finished.map(publicFixture),
  };
}

export function publicFixture(match) {
  if (!match) return match;
  return {
    ...match,
    stream: authorizedStream(match.stream),
  };
}
