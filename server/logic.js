export const LEAGUES = [
  { id: 200, name: "Botola Pro", nameAr: "البطولة المغربية" },
  { id: 2, name: "Champions League", nameAr: "دوري أبطال أوروبا" },
  { id: 39, name: "Premier League", nameAr: "الدوري الإنجليزي" },
  { id: 140, name: "La Liga", nameAr: "الدوري الإسباني" },
  { id: 135, name: "Serie A", nameAr: "الدوري الإيطالي" },
  { id: 78, name: "Bundesliga", nameAr: "الدوري الألماني" },
  { id: 61, name: "Ligue 1", nameAr: "الدوري الفرنسي" },
];

export const FEATURED_IDS = new Set(LEAGUES.map((league) => league.id));

const LIVE = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);
const UPCOMING = new Set(["NS", "TBD", "PST"]);

export function bucket(short) {
  if (LIVE.has(short)) return "live";
  if (UPCOMING.has(short)) return "upcoming";
  return "finished";
}

export function safeTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "Africa/Casablanca";
  }
}

export function calendarDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addCalendarDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function pacedTtl({
  minMs,
  remaining,
  limit,
  now = Date.now(),
  reserve = 25,
  emptyMs = 30 * 60 * 1000,
}) {
  if (remaining == null || limit == null) return minMs;
  const liveBudget = remaining - reserve;
  if (liveBudget <= 0) return Math.max(minMs, emptyMs);
  const nextMidnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1
  );
  const msLeft = Math.max(60_000, nextMidnight - now);
  return Math.max(minMs, Math.floor(msLeft / liveBudget));
}

export function normalizeFixture(raw) {
  if (!raw?.fixture?.id || !raw.teams?.home?.name || !raw.teams?.away?.name) return null;

  const match = {
    id: raw.fixture.id,
    kickoff: raw.fixture.date,
    status: {
      short: raw.fixture.status?.short || "NS",
      long: raw.fixture.status?.long || raw.fixture.status?.short || "Scheduled",
      elapsed: raw.fixture.status?.elapsed ?? null,
      extra: raw.fixture.status?.extra ?? null,
    },
    venue: {
      name: raw.fixture.venue?.name || null,
      city: raw.fixture.venue?.city || null,
    },
    referee: raw.fixture.referee || null,
    league: {
      id: raw.league?.id ?? null,
      name: raw.league?.name || "Competition",
      country: raw.league?.country || null,
      logo: raw.league?.logo || null,
      season: raw.league?.season ?? null,
      round: raw.league?.round || null,
    },
    home: team(raw.teams.home),
    away: team(raw.teams.away),
    goals: {
      home: raw.goals?.home ?? null,
      away: raw.goals?.away ?? null,
    },
    score: {
      ht: pair(raw.score?.halftime),
      ft: pair(raw.score?.fulltime),
      et: pair(raw.score?.extratime),
      pen: pair(raw.score?.penalty),
    },
    eventSummary: null,
    stream: officialStream(raw),
  };

  if (Array.isArray(raw.events)) {
    match.eventSummary = summarizeEvents(raw.events, match.home.id, match.away.id);
  }

  return match;
}

function team(value) {
  return {
    id: value.id ?? null,
    name: value.name,
    logo: value.logo || null,
  };
}

function pair(value) {
  if (!value || value.home == null || value.away == null) return null;
  return { home: value.home, away: value.away };
}

function knownPlayerName(name) {
  const value = String(name || "").trim();
  if (!value || /^unknown player$/i.test(value)) return "";
  return value;
}

export function officialStream(raw) {
  const value = raw?.fixture?.stream ?? raw?.stream ?? null;
  const url = typeof value === "string" ? value : value?.url;
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return null;
    return { url: parsed.href };
  } catch {
    return null;
  }
}

export function summarizeEvents(events, homeId, awayId) {
  const summary = {
    goals: [],
    cards: {
      home: { yellow: 0, red: 0 },
      away: { yellow: 0, red: 0 },
    },
  };

  for (const event of events || []) {
    const side = event.team?.id === homeId ? "home" : event.team?.id === awayId ? "away" : null;
    const detail = event.detail || "";

    const player = knownPlayerName(event.player?.name);
    if (event.type === "Goal" && detail !== "Missed Penalty" && player && side) {
      summary.goals.push({
        side,
        minute: event.time?.elapsed ?? null,
        extra: event.time?.extra ?? null,
        player,
        detail,
        assist: knownPlayerName(event.assist?.name) || null,
      });
    }

    if (event.type === "Card" && side) {
      if (detail === "Yellow Card") summary.cards[side].yellow += 1;
      if (detail === "Red Card" || detail === "Second Yellow card") summary.cards[side].red += 1;
    }
  }

  return summary;
}

export function normalizeEvents(events) {
  return (events || []).map((event) => ({
    minute: event.time?.elapsed ?? null,
    extra: event.time?.extra ?? null,
    team: {
      id: event.team?.id ?? null,
      name: event.team?.name || null,
      logo: event.team?.logo || null,
    },
    player: knownPlayerName(event.player?.name) || null,
    assist: knownPlayerName(event.assist?.name) || null,
    type: event.type || "Event",
    detail: event.detail || null,
    comments: event.comments || null,
  }));
}

export function normalizeStatistics(rows) {
  return (rows || []).map((row) => ({
    team: {
      id: row.team?.id ?? null,
      name: row.team?.name || "Team",
      logo: row.team?.logo || null,
    },
    stats: (row.statistics || []).map((item) => ({
      type: item.type,
      value: item.value ?? null,
    })),
  }));
}

export function normalizeLineups(rows) {
  return (rows || []).map((row) => ({
    team: {
      id: row.team?.id ?? null,
      name: row.team?.name || "Team",
      logo: row.team?.logo || null,
    },
    formation: row.formation || null,
    coach: row.coach?.name || null,
    startXI: (row.startXI || []).map(playerRow),
    substitutes: (row.substitutes || []).map(playerRow),
  }));
}

function playerRow(row) {
  return {
    id: row.player?.id ?? null,
    name: row.player?.name || "Player",
    number: row.player?.number ?? null,
    pos: row.player?.pos || null,
    grid: row.player?.grid || null,
  };
}

export function normalizeStandings(response) {
  const league = response?.[0]?.league;
  if (!league) return null;

  return {
    id: league.id ?? null,
    name: league.name || "Standings",
    season: league.season ?? null,
    logo: league.logo || null,
    groups: (league.standings || []).map((group) => ({
      name: group.find((row) => row.group)?.group || null,
      rows: group.map((row) => ({
        rank: row.rank ?? null,
        team: {
          id: row.team?.id ?? null,
          name: row.team?.name || "Team",
          logo: row.team?.logo || null,
        },
        played: row.all?.played ?? null,
        win: row.all?.win ?? null,
        draw: row.all?.draw ?? null,
        lose: row.all?.lose ?? null,
        goalsFor: row.all?.goals?.for ?? null,
        goalsAgainst: row.all?.goals?.against ?? null,
        gd: row.goalsDiff ?? null,
        points: row.points ?? null,
        form: row.form || null,
      })),
    })),
  };
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function dateWithin(iso, today, days) {
  if (!isIsoDate(iso) || !isIsoDate(today)) return false;
  const distance = Math.abs(Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`));
  return distance <= days * 24 * 60 * 60 * 1000;
}

export function labelForLeague(league) {
  const known = LEAGUES.find((item) => item.id === league?.id);
  return known?.nameAr || league?.name || "بطولة";
}

export function mergeLive(dayMatches, liveMatches) {
  const live = new Map(liveMatches.map((match) => [match.id, match]));
  return dayMatches.map((match) => {
    const fresh = live.get(match.id);
    if (!fresh) return match;
    return {
      ...match,
      status: fresh.status,
      goals: fresh.goals,
      score: fresh.score,
      eventSummary: fresh.eventSummary || match.eventSummary,
      stream: fresh.stream ?? null,
    };
  });
}

export function sortDay(matches) {
  return [...matches].sort((a, b) => {
    const liveA = bucket(a.status.short) === "live" ? 0 : 1;
    const liveB = bucket(b.status.short) === "live" ? 0 : 1;
    if (liveA !== liveB) return liveA - liveB;
    return new Date(a.kickoff) - new Date(b.kickoff);
  });
}

export function filterLeague(matches, league) {
  if (league === "all") return matches;
  if (league === "featured") return matches.filter((match) => FEATURED_IDS.has(match.league.id));
  return matches.filter((match) => match.league.id === league);
}

export function parseLeague(value) {
  if (!value || value === "featured") return "featured";
  if (value === "all") return "all";
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return "featured";
  return id;
}

export function groupMatches(matches, mode, timeZone) {
  if (mode === "league") {
    const groups = new Map();
    for (const match of matches) {
      const key = String(match.league.id ?? match.league.name);
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          label: labelForLeague(match.league),
          logo: match.league.logo,
          matches: [],
        });
      }
      groups.get(key).matches.push(match);
    }
    return [...groups.values()].sort((a, b) => {
      const ai = LEAGUES.findIndex((league) => String(league.id) === a.id);
      const bi = LEAGUES.findIndex((league) => String(league.id) === b.id);
      if (ai === -1 && bi === -1) return a.label.localeCompare(b.label);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  const groups = new Map();
  for (const match of matches) {
    const key = dateKey(match.kickoff, timeZone);
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        label: formatGroupLabel(match.kickoff, timeZone),
        logo: null,
        matches: [],
      });
    }
    groups.get(key).matches.push(match);
  }

  const ordered = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (mode === "date-desc") ordered.reverse();
  return ordered;
}

function dateKey(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return calendarDate(date, timeZone);
}

function formatGroupLabel(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

export function sortMatches(matches, scope) {
  const copy = [...matches];
  if (scope === "upcoming") {
    copy.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  } else if (scope === "finished") {
    copy.sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));
  } else {
    copy.sort((a, b) => (b.status.elapsed ?? -1) - (a.status.elapsed ?? -1));
  }
  return copy;
}

export function errorText(errors) {
  if (!errors) return "";
  if (Array.isArray(errors)) return errors.filter(Boolean).join("; ");
  if (typeof errors === "object") return Object.values(errors).filter(Boolean).join("; ");
  return String(errors);
}
