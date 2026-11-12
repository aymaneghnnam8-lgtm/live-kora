import assert from "node:assert/strict";
import test from "node:test";
import {
  bucket,
  dateWithin,
  filterLeague,
  isIsoDate,
  mergeLive,
  normalizeFixture,
  officialStream,
  pacedTtl,
  summarizeEvents,
} from "./logic.js";
import { minuteLabel, statusLabel } from "../public/js/format.js";
import { isFootballNews, parseRss, truncate } from "./news.js";

test("scheduled fixtures keep a null score", () => {
  const match = normalizeFixture({
    fixture: {
      id: 10,
      date: "2026-11-08T20:00:00+00:00",
      status: { short: "NS", long: "Not Started", elapsed: null, extra: null },
      venue: { name: "Stadium", city: "City" },
      referee: null,
    },
    league: { id: 39, name: "Premier League", country: "England", logo: null, season: 2026, round: "Regular Season - 11" },
    teams: {
      home: { id: 1, name: "Arsenal", logo: null },
      away: { id: 2, name: "Chelsea", logo: null },
    },
    goals: { home: null, away: null },
    score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null } },
  });

  assert.equal(match.goals.home, null);
  assert.equal(match.goals.away, null);
  assert.equal(match.score.ft, null);
  assert.equal(bucket(match.status.short), "upcoming");
});

test("a real 0-0 stays 0-0", () => {
  const match = normalizeFixture({
    fixture: {
      id: 11,
      date: "2026-11-08T17:00:00+00:00",
      status: { short: "FT", long: "Match Finished", elapsed: 90, extra: null },
    },
    league: { id: 200, name: "Botola Pro", season: 2026 },
    teams: {
      home: { id: 3, name: "Wydad AC", logo: null },
      away: { id: 4, name: "Raja CA", logo: null },
    },
    goals: { home: 0, away: 0 },
    score: { fulltime: { home: 0, away: 0 } },
  });

  assert.deepEqual(match.goals, { home: 0, away: 0 });
  assert.equal(bucket(match.status.short), "finished");
});

test("broken fixture rows are dropped instead of invented", () => {
  assert.equal(normalizeFixture({ fixture: { id: 1 } }), null);
  assert.equal(normalizeFixture(null), null);
});

test("event summary counts only API events", () => {
  const summary = summarizeEvents(
    [
      { time: { elapsed: 12 }, team: { id: 1 }, player: { name: "Saka" }, type: "Goal", detail: "Normal Goal" },
      { time: { elapsed: 40 }, team: { id: 2 }, player: { name: "Palmer" }, type: "Card", detail: "Yellow Card" },
      { time: { elapsed: 70 }, team: { id: 1 }, player: { name: "Rice" }, type: "Card", detail: "Second Yellow card" },
      { time: { elapsed: 80 }, team: { id: 2 }, type: "Goal", detail: "Missed Penalty" },
      { time: { elapsed: 81 }, team: { id: 2 }, type: "Goal", detail: "Normal Goal" },
      { time: { elapsed: 82, extra: 1 }, team: { id: 1 }, player: { name: "Unknown player" }, type: "Goal", detail: "Normal Goal" },
    ],
    1,
    2
  );

  assert.equal(summary.goals.length, 1);
  assert.equal(summary.goals[0].player, "Saka");
  assert.equal(summary.goals[0].minute, 12);
  assert.equal(summary.cards.away.yellow, 1);
  assert.equal(summary.cards.home.red, 1);
  assert.equal(summary.cards.home.yellow, 0);
});

test("only an https stream supplied by the fixture is playable", () => {
  assert.equal(officialStream({ fixture: { id: 1 } }), null);
  assert.equal(officialStream({ fixture: { stream: "http://cdn.example/live.m3u8" } }), null);
  assert.equal(officialStream({ fixture: { stream: "javascript:alert(1)" } }), null);
  assert.deepEqual(officialStream({ fixture: { stream: "https://cdn.example/live.m3u8" } }), {
    url: "https://cdn.example/live.m3u8",
  });
});

test("status labels name the period and keep the minute separate", () => {
  assert.equal(statusLabel({ short: "1H", elapsed: 23 }), "الشوط الأول");
  assert.equal(statusLabel({ short: "HT", elapsed: 45 }), "استراحة");
  assert.equal(statusLabel({ short: "2H", elapsed: 70 }), "الشوط الثاني");
  assert.equal(statusLabel({ short: "FT", elapsed: 90 }), "انتهت");
  assert.equal(statusLabel({ short: "NS" }), "لم تبدأ");
  assert.equal(statusLabel({ short: "BT", elapsed: 105 }), "استراحة بين الأشواط الإضافية");
  assert.equal(minuteLabel({ short: "1H", elapsed: 23 }), "23'");
  assert.equal(minuteLabel({ short: "2H", elapsed: 90, extra: 2 }), "90+2'");
  assert.equal(minuteLabel({ short: "HT", elapsed: 45 }), "");
  assert.equal(minuteLabel({ short: "FT", elapsed: 90 }), "");
});

test("featured filter does not add matches", () => {
  const matches = [
    { league: { id: 39 } },
    { league: { id: 999 } },
  ];
  assert.equal(filterLeague(matches, "featured").length, 1);
  assert.equal(filterLeague(matches, "all").length, 2);
  assert.equal(filterLeague([], "featured").length, 0);
});

test("live overlay replaces only matches the API marks live", () => {
  const day = [{ id: 1, goals: { home: null, away: null }, status: { short: "NS" }, score: null, eventSummary: null }];
  const live = [{ id: 1, goals: { home: 1, away: 0 }, status: { short: "1H", elapsed: 12 }, score: { ht: null }, eventSummary: null }];
  const merged = mergeLive(day, live);
  assert.deepEqual(merged[0].goals, { home: 1, away: 0 });
  assert.equal(mergeLive(day, []).length, 1);
  assert.equal(mergeLive([], live).length, 0);
});

test("dates stay inside a real calendar", () => {
  assert.equal(isIsoDate("2026-11-09"), true);
  assert.equal(isIsoDate("2026-02-31"), false);
  assert.equal(dateWithin("2026-11-10", "2026-11-09", 30), true);
  assert.equal(dateWithin("2026-02-01", "2026-11-09", 30), false);
});

test("news parser keeps a short excerpt and drops the full article body", () => {
  const xml = `<rss><channel><item>
    <title><![CDATA[برشلونة يفوز في الدوري]]></title>
    <link>https://www.france24.com/ar/example</link>
    <description><![CDATA[${"أ".repeat(400)}]]></description>
    <content:encoded><![CDATA[هذا نص المقال الكامل الذي لا يجب عرضه]]></content:encoded>
  </item><item>
    <title>اجتماع سياسي</title>
    <link>https://www.france24.com/ar/politics</link>
    <description>خبر غير رياضي</description>
  </item></channel></rss>`;
  const items = parseRss(xml, "فرانس 24");
  assert.equal(items.length, 2);
  assert.equal(items[0].excerpt.length <= 160, true);
  assert.equal(items[0].excerpt.includes("لا يجب عرضه"), false);
  assert.equal(isFootballNews(items[0].title), true);
  assert.equal(isFootballNews(items[1].title), false);
  assert.equal(isFootballNews("الملاكمة في باريس"), false);
  assert.equal(isFootballNews("بطل العالم في فورمولا 1"), false);
  assert.equal(truncate("قصير"), "قصير");
});

test("pacing slows a small daily quota and stays fast on a large one", () => {
  const noon = Date.parse("2026-11-08T12:00:00Z");
  const guarded = pacedTtl({ minMs: 30_000, remaining: 80, limit: 100, now: noon });
  const paid = pacedTtl({ minMs: 30_000, remaining: 7000, limit: 7500, now: noon });
  const empty = pacedTtl({ minMs: 30_000, remaining: 10, limit: 100, now: noon });

  assert.ok(guarded > 30_000);
  assert.equal(paid, 30_000);
  assert.equal(empty, 30 * 60 * 1000);
});
