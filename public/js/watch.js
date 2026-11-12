import { getMatch, getStatus } from "./api.js";
import { el, eventTimeline, hero, notice, setupPanel, statsBlock } from "./components.js";
import { ago, clockTime, minuteLabel, statusKind, statusLabel } from "./format.js";
import { openLiveFeed } from "./live-feed.js";

const NO_STREAM = "لا يتوفر بث رسمي لهذا الماتش حالياً";
const watchNode = document.querySelector("#watch");
const syncNode = document.querySelector("#sync");
const noticeNode = document.querySelector("#notice");
const fixtureId = location.pathname.split("/").filter(Boolean).at(-1) || "";

let requestId = 0;
let timeZone = "Africa/Casablanca";
let fetchedAt = 0;
let current = null;

boot();

async function boot() {
  if (!/^\d{1,12}$/.test(fixtureId)) {
    syncNode.textContent = "لا يوجد رقم مباراة";
    watchNode.replaceChildren(el("p", { class: "empty" }, "افتح مباراة مباشرة من الصفحة الرئيسية."));
    return;
  }
  try {
    const status = await getStatus();
    timeZone = status.timezone || timeZone;
    if (!status.configured) {
      syncNode.textContent = "مفتاح API غير موجود";
      watchNode.replaceChildren(setupPanel());
      return;
    }
  } catch (error) {
    syncNode.textContent = "الخادم غير متاح";
    watchNode.replaceChildren(el("p", { class: "empty" }, error.message));
    return;
  }
  await load(false);
  openLiveFeed(applySnapshot);
}

async function load(refresh) {
  const token = ++requestId;
  try {
    const data = await getMatch(fixtureId, refresh);
    if (token !== requestId) return;
    current = data;
    timeZone = data.timezone || timeZone;
    fetchedAt = data.fetchedAt;
    const notes = [data.warning, data.stale ? "تُعرض آخر استجابة محفوظة." : ""].filter(Boolean);
    const noteNode = notice(notes.join(" "));
    noticeNode.replaceChildren(...(noteNode ? [noteNode] : []));
    render(data);
    paintSync();
  } catch (error) {
    if (token !== requestId) return;
    if (error.code === "missing_api_key") {
      watchNode.replaceChildren(setupPanel());
      return;
    }
    const errorNode = notice(error.message);
    noticeNode.replaceChildren(...(errorNode ? [errorNode] : []));
    if (!watchNode.querySelector(".screen")) {
      watchNode.replaceChildren(el("p", { class: "empty" }, "API-Football لم يُرجع هذه المباراة."));
    }
  }
}

function render(data) {
  const match = data.match;
  document.title = `${match.home.name} ضد ${match.away.name} · دار الكورة`;

  watchNode.replaceChildren(
    infoBlock(match),
    hero(match, timeZone),
    playerFrame(data.stream),
    panel("الأحداث", eventTimeline(data.events, data.errors.events)),
    panel("الإحصائيات", statsBlock(data.statistics, data.errors.statistics))
  );
}

function infoBlock(match) {
  const kind = match.ended ? "finished" : statusKind(match.status.short);
  const clock = [shownStatus(match), minuteLabel(match.status)].filter(Boolean).join(" ");
  return el("section", { class: "watch-info" }, [
    kind === "live"
      ? el("span", { class: "live-dot" }, "LIVE")
      : el("span", { class: "status-label" }, shownStatus(match)),
    el("span", {}, match.league.name),
    el("span", { class: "watch-minute" }, clock),
  ]);
}

function shownStatus(match) {
  if (match.ended && statusKind(match.status.short) === "live") return "انتهت";
  return statusLabel(match.status);
}

function applySnapshot(snapshot) {
  if (!current) return;
  const live = (snapshot.matches || []).find((match) => String(match.id) === String(fixtureId));
  const finished = (snapshot.finished || []).find((match) => String(match.id) === String(fixtureId));
  const match = live || finished;
  if (!match) return;
  const nextStream = live ? match.stream : null;
  current.match = {
    ...current.match,
    status: match.status || current.match.status,
    goals: match.goals || current.match.goals,
    score: match.score ?? current.match.score,
    ended: Boolean(finished && !live),
  };
  current.stream = nextStream;
  if (snapshot.fetchedAt) fetchedAt = snapshot.fetchedAt;
  watchNode.querySelector(".hero")?.replaceWith(hero(current.match, timeZone));
  watchNode.querySelector(".watch-info")?.replaceWith(infoBlock(current.match));
  const frame = watchNode.querySelector(".screen");
  const nextUrl = playableStream(nextStream);
  const currentUrl = frame?.querySelector("video, iframe")?.getAttribute("src") || "";
  if (frame && nextUrl !== currentUrl) frame.replaceWith(playerFrame(nextStream));
  paintSync();
}

function playerFrame(stream) {
  const url = playableStream(stream);
  if (!url) return el("div", { class: "screen", id: "player" }, el("p", {}, NO_STREAM));
  const media = /\.(mp4|webm)(?:$|\?)/i.test(url)
    ? el("video", { controls: true, playsinline: true, src: url })
    : el("iframe", {
      src: url,
      title: "البث الرسمي",
      allow: "autoplay; fullscreen; encrypted-media",
      allowfullscreen: true,
      referrerpolicy: "no-referrer",
    });
  return el("div", { class: "screen", id: "player" }, media);
}

function playableStream(stream) {
  if (!stream?.url || typeof stream.url !== "string") return "";
  try {
    const parsed = new URL(stream.url);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function panel(title, body) {
  return el("section", { class: "panel" }, [el("h2", {}, title), body]);
}

function paintSync() {
  if (!fetchedAt) return;
  const quota = current?.quota;
  const left = quota?.remaining != null && quota?.limit != null ? ` · ${quota.remaining}/${quota.limit}` : "";
  syncNode.textContent = `آخر تحديث ${clockTime(fetchedAt, timeZone)} · ${ago(fetchedAt)}${left}`;
}

setInterval(paintSync, 1000);
