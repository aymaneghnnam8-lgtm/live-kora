import { getMatch, getStatus } from "./api.js";
import { eventTimeline, hero, lineupsBlock, notice, setupPanel, standingsBlock, statsBlock } from "./components.js";
import { ago, clockTime, minuteLabel, statusKind, statusLabel } from "./format.js";
import { openLiveFeed } from "./live-feed.js";

const params = new URLSearchParams(location.search);
const id = params.get("id");
const syncNode = document.querySelector("#sync");
const refreshButton = document.querySelector("#refresh");
const noticeNode = document.querySelector("#notice");
const detailNode = document.querySelector("#detail");

let requestId = 0;
let timeZone = "Africa/Casablanca";
let fetchedAt = 0;
let current = null;

refreshButton.addEventListener("click", () => load(false));
setInterval(() => {
  if (!fetchedAt || !current) return;
  const quota = current.quota;
  const left = quota?.remaining != null && quota?.limit != null ? ` · ${quota.remaining}/${quota.limit}` : "";
  syncNode.textContent = `آخر تحديث ${clockTime(fetchedAt, timeZone)} · ${ago(fetchedAt)}${left}`;
}, 1000);

boot();

async function boot() {
  if (!/^\d{1,12}$/.test(id || "")) {
    syncNode.textContent = "لا يوجد رقم مباراة";
    detailNode.replaceChildren(note("افتح مباراة من لوحة النتائج. هذه الصفحة لا تنشئ مباراة."));
    return;
  }
  try {
    const status = await getStatus();
    timeZone = status.timezone || timeZone;
    if (!status.configured) {
      syncNode.textContent = "مفتاح API غير موجود";
      detailNode.replaceChildren(setupPanel());
      return;
    }
  } catch (error) {
    syncNode.textContent = "الخادم غير متاح";
    detailNode.replaceChildren(note(error.message));
    return;
  }
  refreshButton.hidden = false;
  await load(false);
  openLiveFeed(applySnapshot);
}

async function load(refresh) {
  const token = ++requestId;
  refreshButton.disabled = true;
  try {
    const data = await getMatch(id, refresh);
    if (token !== requestId) return;
    current = data;
    timeZone = data.timezone || timeZone;
    fetchedAt = data.fetchedAt;
    const notes = [data.warning, data.stale ? "تُعرض آخر استجابة محفوظة." : ""].filter(Boolean);
    const noteNode = notice(notes.join(" "));
    noticeNode.replaceChildren(...(noteNode ? [noteNode] : []));
    render(data);
    document.title = `${data.match.home.name} ضد ${data.match.away.name} · دار الكورة`;
  } catch (error) {
    if (token !== requestId) return;
    if (error.code === "missing_api_key") {
      detailNode.replaceChildren(setupPanel());
      return;
    }
    const errorNode = notice(error.message);
    noticeNode.replaceChildren(...(errorNode ? [errorNode] : []));
    if (!detailNode.querySelector(".hero")) detailNode.replaceChildren(note("API-Football لم يُرجع هذه المباراة."));
  } finally {
    if (token === requestId) refreshButton.disabled = false;
  }
}

function render(data) {
  const match = data.match;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = metaText(match);

  detailNode.replaceChildren(
    hero(match, timeZone),
    meta,
    panel("الأحداث", eventTimeline(data.events, data.errors.events)),
    panel("الإحصائيات", statsBlock(data.statistics, data.errors.statistics)),
    panel("التشكيلة", lineupsBlock(data.lineups, match, data.errors.lineups)),
    panel("الترتيب", standingsBlock(data.standings, data.errors.standings))
  );
}

function metaText(match) {
  return [
    match.league.name,
    match.league.round,
    [shownStatus(match), minuteLabel(match.status)].filter(Boolean).join(" "),
    match.status.long,
    [match.venue?.name, match.venue?.city].filter(Boolean).join("، "),
    match.referee ? `الحكم ${match.referee}` : "",
  ].filter(Boolean).join(" · ");
}

function shownStatus(match) {
  if (match.ended && statusKind(match.status.short) === "live") return "انتهت";
  return statusLabel(match.status);
}

function applySnapshot(snapshot) {
  if (!current) return;
  const live = (snapshot.matches || []).find((match) => String(match.id) === String(id));
  const finished = (snapshot.finished || []).find((match) => String(match.id) === String(id));
  const match = live || finished;
  if (!match) return;
  current.match = {
    ...current.match,
    status: match.status || current.match.status,
    goals: match.goals || current.match.goals,
    score: match.score ?? current.match.score,
    ended: Boolean(finished && !live),
  };
  if (snapshot.fetchedAt) fetchedAt = snapshot.fetchedAt;
  detailNode.querySelector(".hero")?.replaceWith(hero(current.match, timeZone));
  const meta = detailNode.querySelector(".meta");
  if (meta) meta.textContent = metaText(current.match);
}

function panel(title, body) {
  const section = document.createElement("section");
  section.className = "panel";
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading, body);
  return section;
}

function note(text) {
  const node = document.createElement("p");
  node.className = "section-error";
  node.textContent = text;
  return node;
}

