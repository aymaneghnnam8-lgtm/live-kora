import { getDay, getLive, getStatus } from "./api.js";
import { emptyState, groupSection, matchCard, notice, setupPanel, updateMatchCard } from "./components.js";
import { addDays, ago, arabicDay, clockTime, moroccoToday, statusKind } from "./format.js";
import { openLiveFeed } from "./live-feed.js";

const syncNode = document.querySelector("#sync");
const daysNode = document.querySelector("#days");
const dateInput = document.querySelector("#date");
const refreshButton = document.querySelector("#refresh");
const stateNode = document.querySelector("#state");
const chipsNode = document.querySelector("#chips");
const windowNode = document.querySelector("#window");
const noticeNode = document.querySelector("#notice");
const liveNode = document.querySelector("#live");
const boardNode = document.querySelector("#board");

const STATUS_FILTERS = [
  { id: "all", label: "الكل" },
  { id: "live", label: "مباشر" },
  { id: "upcoming", label: "لم تبدأ" },
  { id: "finished", label: "انتهت" },
];

const params = new URLSearchParams(location.search);
let timeZone = "Africa/Casablanca";
let today = moroccoToday(timeZone);
let date = params.get("date") || today;
let league = params.get("league") || "all";
let statusFilter = STATUS_FILTERS.some((item) => item.id === params.get("status")) ? params.get("status") : "all";
let leagues = [];
let configured = false;
let fetchedAt = 0;
let quota = null;
let requestId = 0;
let dayPayload = null;
let separateLive = [];
let separateLiveError = "";
let feedSnapshot = null;
let feedReady = false;
const previousScores = new Map();

refreshButton.addEventListener("click", () => load(false));
dateInput.addEventListener("change", () => {
  if (!dateInput.value) return;
  date = dateInput.value;
  remember();
  renderDays();
  load(false);
});
setInterval(paintSync, 1000);
boot();

async function boot() {
  try {
    const status = await getStatus();
    configured = status.configured;
    timeZone = status.timezone || timeZone;
    today = status.today || moroccoToday(timeZone);
    leagues = status.leagues || [];
    if (!params.get("date") || location.hash === "#today") date = today;
    dateInput.min = addDays(today, -30);
    dateInput.max = addDays(today, 30);
    dateInput.value = date;
    renderDays();
    renderState();
    renderChips();
    if (!configured) {
      syncNode.textContent = "مفتاح API غير موجود";
      liveNode.hidden = true;
      stateNode.hidden = true;
      boardNode.replaceChildren(setupPanel());
      return;
    }
    refreshButton.hidden = false;
    await load(false);
    connectFeed();
  } catch (error) {
    const offline = error instanceof TypeError;
    syncNode.textContent = offline ? "تعذر الاتصال بالخادم" : "تعذر تجهيز الصفحة";
    boardNode.textContent = error.message || syncNode.textContent;
  }
}

function renderDays() {
  const items = [
    { id: addDays(today, -1), label: "مباريات الأمس" },
    { id: today, label: "مباريات اليوم" },
    { id: addDays(today, 1), label: "مباريات الغد" },
  ];
  daysNode.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(item.id === date));
    button.addEventListener("click", () => {
      date = item.id;
      dateInput.value = date;
      remember();
      renderDays();
      load(false);
    });
    return button;
  }));
}

function renderState() {
  stateNode.replaceChildren(...STATUS_FILTERS.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(item.id === statusFilter));
    button.addEventListener("click", () => {
      if (statusFilter === item.id) return;
      statusFilter = item.id;
      remember();
      renderState();
      paint();
    });
    return button;
  }));
}

function renderChips() {
  const items = [{ id: "all", nameAr: "كل البطولات" }, ...leagues];
  chipsNode.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.nameAr || item.name;
    button.setAttribute("aria-pressed", String(String(item.id) === String(league)));
    button.addEventListener("click", () => {
      league = item.id;
      remember();
      renderChips();
      load(false);
    });
    return button;
  }));
}

function remember() {
  const url = new URL(location.href);
  url.searchParams.set("date", date);
  url.searchParams.set("league", String(league));
  if (statusFilter === "all") url.searchParams.delete("status");
  else url.searchParams.set("status", statusFilter);
  history.replaceState(null, "", url);
}

function wantsSeparateLive() {
  return date !== today && (statusFilter === "all" || statusFilter === "live");
}

async function load(refresh) {
  const token = ++requestId;
  refreshButton.disabled = true;
  windowNode.textContent = arabicDay(date, timeZone);
  const askLive = wantsSeparateLive();
  try {
    const data = await getDay(date, league, refresh);
    let liveBoard = null;
    if (askLive) {
      try {
        liveBoard = await getLive(league, refresh);
      } catch (error) {
        separateLiveError = arabicError(error);
      }
    }
    if (token !== requestId) return;
    dayPayload = data;
    timeZone = data.timezone || timeZone;
    fetchedAt = data.fetchedAt;
    quota = data.quota || liveBoard?.quota || quota;
    if (liveBoard) {
      separateLive = flatten(liveBoard.groups);
      separateLiveError = "";
    } else if (!askLive) {
      separateLive = [];
      separateLiveError = "";
    }
    const notes = [];
    if (data.warning) notes.push(data.warning);
    if (liveBoard?.warning) notes.push(liveBoard.warning);
    if (separateLiveError) notes.push(separateLiveError);
    if (data.stale || liveBoard?.stale) notes.push("تُعرض آخر استجابة محفوظة من الواجهة.");
    showNotice([...new Set(notes)].filter(Boolean).join(" "));
    paint();
    paintSync();
    applyFeed();
  } catch (error) {
    if (token !== requestId) return;
    if (error.code === "missing_api_key") {
      liveNode.hidden = true;
      boardNode.hidden = false;
      boardNode.replaceChildren(setupPanel());
      syncNode.textContent = "مفتاح API غير موجود";
      return;
    }
    showNotice(arabicError(error));
    if (!boardNode.querySelector(".card") && !liveNode.querySelector(".card")) {
      liveNode.hidden = true;
      boardNode.hidden = false;
      boardNode.replaceChildren(emptyState("تعذر التحميل", arabicError(error)));
    }
  } finally {
    if (token === requestId) refreshButton.disabled = false;
  }
}

function currentLiveMatches() {
  if (!dayPayload) return [];
  if (date !== today) return sortLive(separateLive.filter(isLive));
  const map = new Map();
  for (const match of flatten(dayPayload.groups)) {
    if (isLive(match)) map.set(match.id, match);
  }
  for (const match of dayPayload.live || []) {
    if (isLive(match)) map.set(match.id, match);
  }
  return sortLive([...map.values()]);
}

function isLive(match) {
  return !match.ended && statusKind(match.status?.short) === "live";
}

function connectFeed() {
  if (feedReady) return;
  feedReady = true;
  openLiveFeed((snapshot) => {
    feedSnapshot = snapshot;
    if (snapshot?.quota) quota = snapshot.quota;
    applyFeed();
  });
}

function applyFeed() {
  if (!feedSnapshot?.fetchedAt || !dayPayload) return;
  const live = filterLeague(feedSnapshot.matches || []).filter(isLive);
  for (const match of live) replaceMatch(match);
  for (const match of filterLeague(feedSnapshot.finished || [])) replaceMatch({ ...match, ended: true, stream: null });
  if (date === today) dayPayload.live = live;
  else separateLive = live;
  if (feedSnapshot.fetchedAt) fetchedAt = feedSnapshot.fetchedAt;
  paint();
  paintSync();
  if (feedSnapshot.warning) showNotice(feedSnapshot.warning);
}

function replaceMatch(match) {
  for (const group of dayPayload.groups || []) {
    const index = group.matches.findIndex((item) => item.id === match.id);
    if (index < 0) continue;
    const existing = group.matches[index];
    group.matches[index] = {
      ...existing,
      status: match.status || existing.status,
      goals: match.goals || existing.goals,
      score: match.score ?? existing.score,
      stream: match.stream ?? null,
      ended: Boolean(match.ended),
    };
  }
}

function filterLeague(matches) {
  if (String(league) === "all") return matches;
  return matches.filter((match) => String(match.league?.id) === String(league));
}

const findInput = document.querySelector("#find");
findInput?.addEventListener("input", () => {
  applyFind();
  paintRails();
});

function paint() {
  if (!dayPayload) return;
  const changed = scoreChanges(listedMatches());
  renderLive(changed);
  renderBoard(changed);
  applyFind();
  paintRails();
}

function applyFind() {
  const query = findInput?.value.trim().toLowerCase() || "";
  for (const card of document.querySelectorAll("#live .card, #board .card")) {
    card.hidden = Boolean(query) && !card.textContent.toLowerCase().includes(query);
  }
  for (const group of document.querySelectorAll("#board .group")) {
    group.hidden = ![...group.querySelectorAll(".card")].some((card) => !card.hidden);
  }
}

function paintRails() {
  const featured = document.querySelector("#featured");
  const teams = document.querySelector("#side-teams");
  const standings = document.querySelector("#side-standings");
  if (!featured || !teams || !standings) return;
  const cards = [...document.querySelectorAll("#live .card")].filter((card) => !card.hidden).slice(0, 4);
  featured.replaceChildren(...(cards.length ? cards.map(compactMatch) : [railNote("لا توجد مباراة مباشرة")]));
  const names = [];
  for (const node of document.querySelectorAll("#live .team-name, #board .team-name")) {
    const name = node.textContent.trim();
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length === 8) break;
  }
  teams.replaceChildren(...(names.length ? names.map((name) => {
    const item = document.createElement("span");
    item.className = "rail-team";
    item.textContent = name;
    return item;
  }) : [railNote("لا توجد فرق")]));
  if (!standings.childElementCount && leagues.length) {
    standings.replaceChildren(...leagues.map((item) => {
      const link = document.createElement("a");
      link.href = `/leagues.html?id=${item.id}`;
      link.textContent = item.nameAr || item.name;
      return link;
    }));
  }
}

function compactMatch(card) {
  const link = document.createElement("a");
  link.className = "rail-match";
  link.href = card.getAttribute("href") || "/";
  const competition = card.querySelector(".comp")?.textContent.trim() || "";
  const sides = [...card.querySelectorAll(".team-name")].map((node) => node.textContent.trim()).join(" · ");
  const score = [...card.querySelectorAll(".score-num")].map((node) => node.textContent.trim()).join("–");
  link.textContent = [competition, sides, score].filter(Boolean).join(" · ");
  return link;
}

function railNote(text) {
  const note = document.createElement("p");
  note.className = "rail-note";
  note.textContent = text;
  return note;
}

function listedMatches() {
  const fromDay = (dayPayload?.groups || []).flatMap((group) => group.matches || []);
  return [...currentLiveMatches(), ...fromDay];
}

function scoreChanges(matches) {
  const changed = new Set();
  for (const match of matches) {
    const scoreKey = `${match.goals?.home}-${match.goals?.away}`;
    if (previousScores.has(match.id) && previousScores.get(match.id) !== scoreKey) changed.add(match.id);
    previousScores.set(match.id, scoreKey);
  }
  return changed;
}

function renderLive(changed) {
  const visible = statusFilter === "all" || statusFilter === "live";
  liveNode.hidden = !visible;
  if (!visible) {
    delete liveNode.dataset.signature;
    return;
  }
  const matches = currentLiveMatches();
  const failed = date === today ? Boolean(dayPayload.liveFailed) : Boolean(separateLiveError);
  const signature = matches.map((match) => match.id).join(",");
  const heading = liveHeading(matches.length);
  if (failed && !matches.length) {
    delete liveNode.dataset.signature;
    liveNode.replaceChildren(heading, emptyState("تعذر تحميل المباشر", "تعذر تحديث المباريات المباشرة. تُعرض آخر نتيجة محفوظة عند توفرها."));
    return;
  }
  if (!matches.length) {
    delete liveNode.dataset.signature;
    liveNode.replaceChildren(heading, emptyState("لا توجد مباريات مباشرة", "لا توجد مباراة مباشرة الآن ضمن التصفية الحالية."));
    return;
  }
  let list = liveNode.querySelector(".cards");
  if (liveNode.dataset.signature !== signature || !list) {
    list = document.createElement("div");
    list.className = "cards";
    list.append(...matches.map((match) => matchCard(match, timeZone, changed.has(match.id), {
      showLeague: true,
      leagueLabel: leagueLabel(match),
    })));
    liveNode.replaceChildren(heading, list);
    liveNode.dataset.signature = signature;
    setLiveCount(list);
    return;
  }
  const title = liveNode.querySelector("h2");
  if (title) title.replaceWith(heading);
  for (const match of matches) {
    const card = list.querySelector(`[data-match-id="${CSS.escape(String(match.id))}"]`);
    const options = { showLeague: true, leagueLabel: leagueLabel(match) };
    if (!card || !updateMatchCard(card, match, timeZone, changed.has(match.id))) {
      const next = matchCard(match, timeZone, changed.has(match.id), options);
      if (card) card.replaceWith(next);
      else list.append(next);
    }
  }
  setLiveCount(list);
}

function setLiveCount(list) {
  const shown = list?.querySelectorAll(":scope > [data-match-id]").length || 0;
  const node = liveNode.querySelector(".live-count");
  if (node) node.textContent = String(shown);
}

function liveHeading(count) {
  const heading = document.createElement("h2");
  heading.id = "live-title";
  const flag = document.createElement("span");
  flag.className = "live-dot";
  flag.textContent = "LIVE";
  const countNode = document.createElement("span");
  countNode.className = "live-count";
  countNode.textContent = String(count);
  heading.append(flag, document.createTextNode("مباشر"), countNode);
  return heading;
}

function renderBoard(changed) {
  if (statusFilter === "live") {
    boardNode.hidden = true;
    delete boardNode.dataset.signature;
    return;
  }
  boardNode.hidden = false;
  const groups = filteredGroups();
  const signature = groups.map((group) => `${group.id}:${group.matches.map((match) => match.id).join(",")}`).join("|");
  if (!groups.length) {
    delete boardNode.dataset.signature;
    boardNode.replaceChildren(emptyState(emptyTitle(), "API-Football لم يُرجع مباريات لهذا التاريخ ضمن التصفية الحالية."));
    return;
  }
  if (boardNode.dataset.signature === signature && boardNode.querySelector(".card")) {
    for (const group of groups) {
      for (const match of group.matches) {
        const card = boardNode.querySelector(`[data-match-id="${CSS.escape(String(match.id))}"]`);
        if (!updateMatchCard(card, match, timeZone, changed.has(match.id))) {
          card?.replaceWith(matchCard(match, timeZone, changed.has(match.id)));
        }
      }
    }
    return;
  }
  boardNode.dataset.signature = signature;
  boardNode.replaceChildren(...groups.map((group) => groupSection(group, timeZone, changed)));
}

function filteredGroups() {
  const liveIds = new Set(currentLiveMatches().map((match) => String(match.id)));
  return (dayPayload.groups || []).map((group) => ({
    ...group,
    matches: (group.matches || []).filter((match) => {
      if (liveIds.has(String(match.id))) return false;
      const kind = match.ended ? "finished" : statusKind(match.status.short);
      if (statusFilter === "all") return kind !== "live";
      return kind === statusFilter;
    }),
  })).filter((group) => group.matches.length);
}

function emptyTitle() {
  if (statusFilter === "upcoming") return "لا توجد مباريات لم تبدأ";
  if (statusFilter === "finished") return "لا توجد مباريات منتهية";
  return "لا توجد مباريات";
}

function flatten(groups) {
  return (groups || []).flatMap((group) => group.matches || []);
}

function sortLive(matches) {
  return [...matches].sort((a, b) => (b.status?.elapsed ?? -1) - (a.status?.elapsed ?? -1));
}

function leagueLabel(match) {
  const known = leagues.find((item) => String(item.id) === String(match.league?.id));
  return known?.nameAr || match.league?.name || "";
}

function showNotice(text) {
  const node = notice(text);
  noticeNode.replaceChildren(...(node ? [node] : []));
}

function paintSync() {
  if (!configured || !fetchedAt) return;
  const left = quota?.remaining != null && quota?.limit != null ? ` · ${quota.remaining}/${quota.limit} طلباً متبقياً` : "";
  syncNode.textContent = `آخر تحديث ${clockTime(fetchedAt, timeZone)} · ${ago(fetchedAt)}${left}`;
}

function arabicError(error) {
  if (error.code === "bad_request") return "اختر تاريخاً خلال 30 يوماً من اليوم بتوقيت المغرب.";
  if (error.code === "rate_limited") return "تم إبطاء التحديث لحماية حد الواجهة البرمجية.";
  return error.message;
}

window.addEventListener("hashchange", () => {
  if (location.hash !== "#today" || !configured) return;
  date = today;
  dateInput.value = date;
  remember();
  renderDays();
  load(false);
});
