import dotenv from "dotenv";
import path from "node:path";
import {
  addCalendarDays,
  bucket,
  calendarDate,
  errorText,
  dateWithin,
  filterLeague,
  groupMatches,
  isIsoDate,
  LEAGUES,
  mergeLive,
  normalizeEvents,
  normalizeFixture,
  officialStream,
  normalizeLineups,
  normalizeStandings,
  normalizeStatistics,
  pacedTtl,
  safeTimeZone,
  sortDay,
  sortMatches,
  summarizeEvents,
} from "./logic.js";
import { createCache } from "./cache.js";
import { dataDir, root } from "./paths.js";

const envPath = path.join(root, ".env");
dotenv.config({ path: envPath, override: true });
const cache = createCache(path.join(dataDir, "cache.json"));
const BASE = "https://v3.football.api-sports.io";

let chain = Promise.resolve();
const recentCalls = [];

function configuredKey() {
  const key = process.env.API_FOOTBALL_KEY?.trim().replace(/^['"]|['"]$/g, "");
  return key || "";
}

export function timeZone() {
  return safeTimeZone(process.env.DISPLAY_TIMEZONE || "Africa/Casablanca");
}

function reserve() {
  const value = Number(process.env.QUOTA_RESERVE || 25);
  return Number.isFinite(value) && value >= 0 ? value : 25;
}

function liveMinMs() {
  const seconds = Number(process.env.LIVE_CACHE_SECONDS || 30);
  return Math.max(15, Number.isFinite(seconds) ? seconds : 30) * 1000;
}

function canForceRefresh() {
  const quota = cache.getQuota();
  if (quota.remaining == null) return true;
  return quota.remaining > reserve();
}

export function hasQuotaRoom() {
  return canForceRefresh();
}

export function currentLiveTtl() {
  const quota = cache.getQuota();
  return pacedTtl({
    minMs: liveMinMs(),
    remaining: quota.remaining,
    limit: quota.limit,
    reserve: reserve(),
  });
}

function limited(task) {
  const run = chain.then(async () => {
    const now = Date.now();
    const windowed = recentCalls.filter((stamp) => now - stamp < 60_000);
    recentCalls.length = 0;
    recentCalls.push(...windowed);
    if (recentCalls.length >= 8) {
      const wait = 60_000 - (now - recentCalls[0]) + 40;
      if (wait > 20_000) {
        const error = new Error("API per-minute limit reached. Try again shortly.");
        error.code = "rate_limited";
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    recentCalls.push(Date.now());
    return task();
  });
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

const inflight = new Map();

async function apiGet(apiPath, { ttlMs, force = false, allowStale = true } = {}) {
  const fresh = !force && cache.getFresh(apiPath);
  if (fresh) {
    return { value: fresh.value, fetchedAt: fresh.fetchedAt, stale: false, ttlMs: fresh.ttlMs, cached: true };
  }
  if (inflight.has(apiPath)) return inflight.get(apiPath);

  const request = limited(() => fetchUpstream(apiPath, ttlMs, allowStale)).finally(() => {
    inflight.delete(apiPath);
  });
  inflight.set(apiPath, request);
  return request;
}

async function fetchUpstream(apiPath, ttlMs, allowStale) {
  const key = configuredKey();
  if (!key) {
    const error = new Error("Set API_FOOTBALL_KEY in the server .env file. No matches are stored in this project.");
    error.code = "missing_api_key";
    throw error;
  }

  const quota = cache.getQuota();
  if (quota.remaining != null && quota.remaining <= 1) {
    return staleOrThrow(apiPath, "Daily API quota is exhausted. Showing the last saved response when one exists.", "rate_limited", allowStale);
  }

  let response;
  try {
    response = await fetch(`${BASE}${apiPath}`, {
      headers: { "x-apisports-key": key },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (cause) {
    return staleOrThrow(apiPath, `API-Football could not be reached (${cause.message}).`, "upstream", allowStale);
  }

  const limit = numberHeader(response, "x-ratelimit-requests-limit");
  const remaining = numberHeader(response, "x-ratelimit-requests-remaining");
  if (limit != null || remaining != null) {
    cache.setQuota({
      limit: limit ?? quota.limit,
      remaining: remaining ?? quota.remaining,
    });
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return staleOrThrow(apiPath, "API-Football returned a response that was not JSON.", "upstream", allowStale);
  }

  const message = errorText(body.errors);
  if (message) {
    const code = /limit|quota|request/i.test(message) ? "rate_limited" : "upstream";
    return staleOrThrow(apiPath, message, code, allowStale);
  }
  if (!response.ok) {
    return staleOrThrow(apiPath, `API-Football returned HTTP ${response.status}.`, "upstream", allowStale);
  }
  if (!Array.isArray(body.response)) {
    return staleOrThrow(apiPath, "API-Football response did not include a results list.", "upstream", allowStale);
  }

  cache.set(apiPath, body.response, ttlMs);
  const saved = cache.getFresh(apiPath);
  return { value: saved.value, fetchedAt: saved.fetchedAt, stale: false, ttlMs, cached: false };
}

function numberHeader(response, name) {
  const value = response.headers.get(name);
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function staleOrThrow(apiPath, message, code, allowStale) {
  const stale = allowStale ? cache.getAny(apiPath) : null;
  if (stale) {
    return {
      value: stale.value,
      fetchedAt: stale.fetchedAt,
      stale: true,
      ttlMs: stale.ttlMs,
      warning: message,
      cached: false,
    };
  }
  const error = new Error(message);
  error.code = code;
  throw error;
}

function fixturesFrom(pack) {
  return pack.value.map(normalizeFixture).filter(Boolean);
}

function packMeta(packs) {
  const warnings = [...new Set(packs.map((pack) => pack.warning).filter(Boolean))];
  return {
    fetchedAt: Math.min(...packs.map((pack) => pack.fetchedAt)),
    stale: packs.some((pack) => pack.stale),
    warning: warnings[0] || null,
    refreshInMs: Math.max(...packs.map((pack) => pack.ttlMs || 0)),
  };
}

export async function getBoard({ scope, league, force = false }) {
  let refreshSkipped = false;
  if (force && !canForceRefresh()) {
    force = false;
    refreshSkipped = true;
  }

  const zone = timeZone();
  const today = calendarDate(new Date(), zone);
  const dates = scope === "finished"
    ? [addCalendarDays(today, -1), today]
    : [0, 1, 2, 3].map((offset) => addCalendarDays(today, offset));

  if (scope === "live") {
    const ttl = currentLiveTtl();
    const pack = await apiGet(`/fixtures?live=all&timezone=${encodeURIComponent(zone)}`, {
      ttlMs: ttl,
      force,
    });
    let matches = sortMatches(filterLeague(fixturesFrom(pack), league), "live");
    const quota = cache.getQuota();
    const slowed = ttl > liveMinMs();
    return {
      scope,
      league: String(league),
      timezone: zone,
      groups: groupMatches(matches, "league", zone),
      ...packMeta([pack]),
      warning: refreshSkipped
        ? "Refresh skipped to protect the remaining API quota."
        : pack.warning || (slowed ? "Updates are slowed to stay inside the API daily limit." : null),
      quota,
      eventsOnList: matches.some((match) => match.eventSummary),
    };
  }

  const packs = [];
  let dateError = null;
  for (const date of dates) {
    const minMs = date < today ? 6 * 60 * 60 * 1000 : date === today ? 10 * 60 * 1000 : 60 * 60 * 1000;
    const quota = cache.getQuota();
    const ttl = Math.max(
      minMs,
      pacedTtl({
        minMs,
        remaining: quota.remaining,
        limit: quota.limit,
        reserve: reserve(),
      })
    );
    try {
      packs.push(
        await apiGet(`/fixtures?date=${date}&timezone=${encodeURIComponent(zone)}`, { ttlMs: ttl, force })
      );
    } catch (error) {
      if (error.code === "missing_api_key" || (!packs.length && date === dates.at(-1))) throw error;
      dateError = error;
    }
  }
  if (!packs.length && dateError) throw dateError;

  const seen = new Set();
  const matches = [];
  for (const fixture of packs.flatMap(fixturesFrom)) {
    if (seen.has(fixture.id)) continue;
    const kind = bucket(fixture.status.short);
    if (scope === "upcoming" && kind !== "upcoming") continue;
    if (scope === "finished" && kind !== "finished") continue;
    seen.add(fixture.id);
    matches.push(fixture);
  }

  const filtered = sortMatches(filterLeague(matches, league), scope);
  return {
    scope,
    league: String(league),
    timezone: zone,
    groups: groupMatches(filtered, scope === "finished" ? "date-desc" : "date-asc", zone),
    ...packMeta(packs),
    warning: refreshSkipped
      ? "Refresh skipped to protect the remaining API quota."
      : packMeta(packs).warning || dateError?.message || null,
    quota: cache.getQuota(),
    eventsOnList: filtered.some((match) => match.eventSummary),
  };
}

export async function getMatch(id, force = false) {
  let refreshSkipped = false;
  if (force && !canForceRefresh()) {
    force = false;
    refreshSkipped = true;
  }

  const zone = timeZone();
  const fixturePath = `/fixtures?id=${id}&timezone=${encodeURIComponent(zone)}`;
  const liveTtl = currentLiveTtl();
  const fixturePack = await apiGet(fixturePath, { ttlMs: liveTtl, force });
  const rawFixture = fixturePack.value[0];
  const match = normalizeFixture(rawFixture);
  if (!match) {
    const error = new Error("API-Football has no fixture with that id.");
    error.code = "not_found";
    throw error;
  }

  const finished = bucket(match.status.short) === "finished";
  const detailTtl = finished ? 6 * 60 * 60 * 1000 : liveTtl;
  if (finished) cache.extend(fixturePath, detailTtl);

  const sections = await Promise.all([
    loadSection(`/fixtures/events?fixture=${id}`, detailTtl, force),
    loadSection(`/fixtures/statistics?fixture=${id}`, detailTtl, force),
    loadSection(`/fixtures/lineups?fixture=${id}`, detailTtl, force),
    match.league.id && match.league.season
      ? loadSection(`/standings?league=${match.league.id}&season=${match.league.season}`, 60 * 60 * 1000, force)
      : Promise.resolve({ value: [], error: "This fixture did not include a league season, so standings were not requested." }),
  ]);

  const [eventsPack, statsPack, lineupsPack, standingsPack] = sections;
  const events = eventsPack.error ? null : normalizeEvents(eventsPack.value);
  if (events) match.eventSummary = summarizeEvents(eventsPack.value, match.home.id, match.away.id);

  const warnings = [fixturePack.warning, eventsPack.warning, statsPack.warning, lineupsPack.warning, standingsPack.warning].filter(Boolean);

  return {
    timezone: zone,
    match,
    stream: officialStream(rawFixture),
    events,
    statistics: statsPack.error ? null : normalizeStatistics(statsPack.value),
    lineups: lineupsPack.error ? null : normalizeLineups(lineupsPack.value),
    standings: standingsPack.error ? null : normalizeStandings(standingsPack.value),
    errors: {
      events: eventsPack.error || null,
      statistics: statsPack.error || null,
      lineups: lineupsPack.error || null,
      standings: standingsPack.error || null,
    },
    fetchedAt: fixturePack.fetchedAt,
    stale: [fixturePack, eventsPack, statsPack, lineupsPack, standingsPack].some((pack) => pack.stale),
    warning: refreshSkipped
      ? "Refresh skipped to protect the remaining API quota."
      : warnings[0] || null,
    refreshInMs: finished ? detailTtl : liveTtl,
    quota: cache.getQuota(),
  };
}

export async function getDay({ date, league, force = false }) {
  const zone = timeZone();
  const today = calendarDate(new Date(), zone);
  if (!isIsoDate(date) || !dateWithin(date, today, 30)) {
    const error = new Error("Choose a date within 30 days of today in Morocco.");
    error.code = "bad_request";
    throw error;
  }

  let refreshSkipped = false;
  if (force && !canForceRefresh()) {
    force = false;
    refreshSkipped = true;
  }

  const minMs = date === today ? 2 * 60 * 1000 : date < today ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const quota = cache.getQuota();
  const ttl = Math.max(minMs, pacedTtl({
    minMs,
    remaining: quota.remaining,
    limit: quota.limit,
    reserve: reserve(),
  }));
  const dayPack = await apiGet(`/fixtures?date=${date}&timezone=${encodeURIComponent(zone)}`, { ttlMs: ttl, force });
  const packs = [dayPack];
  let matches = fixturesFrom(dayPack);
  let liveMatches = [];
  let liveWarning = null;
  let liveFailed = false;

  if (date === today) {
    try {
      const livePack = await apiGet(`/fixtures?live=all&timezone=${encodeURIComponent(zone)}`, {
        ttlMs: currentLiveTtl(),
        force,
      });
      const liveFixtures = fixturesFrom(livePack);
      liveMatches = sortMatches(
        filterLeague(liveFixtures, league).filter((match) => bucket(match.status.short) === "live"),
        "live"
      );
      matches = mergeLive(matches, liveFixtures);
      packs.push(livePack);
    } catch (error) {
      if (error.code === "missing_api_key") throw error;
      liveWarning = error.message;
      liveFailed = true;
    }
  }

  const filtered = sortDay(filterLeague(matches, league));
  const meta = packMeta(packs);
  const scorePack = packs[1] || dayPack;
  return {
    date,
    today,
    timezone: zone,
    league: String(league),
    groups: groupMatches(filtered, "league", zone),
    live: liveMatches,
    liveFailed,
    fetchedAt: scorePack.fetchedAt,
    stale: meta.stale,
    warning: refreshSkipped
      ? "Refresh skipped to protect the remaining API quota."
      : meta.warning || liveWarning,
    refreshInMs: date === today ? currentLiveTtl() : ttl,
    quota: cache.getQuota(),
    count: filtered.length,
  };
}

export async function getCompetition(id) {
  const known = LEAGUES.find((league) => league.id === id) || null;
  const infoPack = await apiGet(`/leagues?id=${id}&current=true`, { ttlMs: 24 * 60 * 60 * 1000 });
  const entry = infoPack.value[0];
  if (!entry?.league?.id) {
    const error = new Error("API-Football has no competition with that id.");
    error.code = "not_found";
    throw error;
  }
  const season = (entry.seasons || []).find((item) => item.current)?.year ?? entry.seasons?.[0]?.year ?? null;
  let standings = null;
  let standingsError = null;
  if (!season) {
    standingsError = "The API did not include a season for this competition.";
  } else {
    const pack = await loadSection(`/standings?league=${id}&season=${season}`, 6 * 60 * 60 * 1000, false);
    standings = pack.error ? null : normalizeStandings(pack.value);
    standingsError = pack.error || (standings ? null : "API-Football returned no standings for this competition.");
  }

  return {
    competition: {
      id: entry.league.id,
      name: entry.league.name,
      nameAr: known?.nameAr || null,
      logo: entry.league.logo || null,
      country: entry.country?.name || null,
      season,
    },
    standings,
    errors: { standings: standingsError },
    fetchedAt: infoPack.fetchedAt,
    stale: infoPack.stale,
    warning: infoPack.warning || null,
    quota: cache.getQuota(),
  };
}

async function loadSection(apiPath, ttlMs, force) {
  try {
    return await apiGet(apiPath, { ttlMs, force });
  } catch (error) {
    return { value: [], error: error.message, stale: false, warning: null, fetchedAt: null, ttlMs };
  }
}

export async function syncLiveFixtures() {
  const zone = timeZone();
  const ttl = currentLiveTtl();
  const pack = await apiGet(`/fixtures?live=all&timezone=${encodeURIComponent(zone)}`, {
    ttlMs: ttl,
    force: false,
  });
  return {
    matches: fixturesFrom(pack).filter((match) => bucket(match.status.short) === "live"),
    fetchedAt: pack.fetchedAt,
    stale: Boolean(pack.stale),
    cached: Boolean(pack.cached),
    warning: pack.warning || null,
    quota: cache.getQuota(),
    ttlMs: pack.ttlMs,
  };
}

export async function readFixture(id) {
  const zone = timeZone();
  const pack = await apiGet(`/fixtures?id=${id}&timezone=${encodeURIComponent(zone)}`, {
    ttlMs: currentLiveTtl(),
    force: false,
  });
  return {
    match: normalizeFixture(pack.value[0]),
    cached: Boolean(pack.cached),
    stale: Boolean(pack.stale),
    warning: pack.warning || null,
    quota: cache.getQuota(),
  };
}

export function publicStatus() {
  const quota = cache.getQuota();
  return {
    configured: Boolean(configuredKey()),
    timezone: timeZone(),
    today: calendarDate(new Date(), timeZone()),
    leagues: LEAGUES,
    quota,
    liveCacheSeconds: Math.round(currentLiveTtl() / 1000),
    minimumLiveCacheSeconds: Math.round(liveMinMs() / 1000),
  };
}
