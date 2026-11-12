import { hasScore, kickoffTime, knownPlayer, minuteLabel, minuteText, statusKind, statusLabel } from "./format.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function safeUrl(url) {
  if (typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function initials(name) {
  return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function logo(url, name, className) {
  const src = safeUrl(url);
  if (!src || !src.startsWith("https:")) {
    return el("span", { class: `${className} logo-fallback`, "aria-hidden": "true" }, initials(name));
  }
  const image = el("img", { class: className, src, alt: "" });
  image.addEventListener("error", () => {
    image.replaceWith(el("span", { class: `${className} logo-fallback`, "aria-hidden": "true" }, initials(name)));
  });
  return image;
}

export function setupPanel() {
  return el("section", { class: "setup" }, [
    el("h2", {}, "اربط API-Football"),
    el("p", {}, "لا توجد نتائج مخزنة في المشروع. المباريات تظهر فقط بعد وضع مفتاح حقيقي."),
    el("ol", {}, [
      el("li", {}, [
        "أنشئ مفتاحاً من ",
        el("a", { href: "https://dashboard.api-football.com/", target: "_blank", rel: "noreferrer" }, "dashboard.api-football.com"),
        ".",
      ]),
      el("li", {}, "انسخ .env.example إلى .env"),
      el("li", {}, "ضع المفتاح في API_FOOTBALL_KEY داخل ملف .env على الخادم"),
      el("li", {}, "أعد تشغيل الخادم بالأمر npm start"),
    ]),
  ]);
}

export function emptyState(title, text) {
  return el("section", { class: "empty" }, [el("h2", {}, title), el("p", {}, text)]);
}

export function notice(text) {
  return text ? el("p", { class: "notice" }, text) : null;
}

function cardKind(match) {
  if (match.ended) return "finished";
  return statusKind(match.status.short);
}

function cardStatus(match) {
  if (match.ended && statusKind(match.status.short) === "live") return "انتهت";
  return statusLabel(match.status);
}

export function matchCard(match, timeZone, changed, options = {}) {
  const kind = cardKind(match);
  const leagueLabel = options.leagueLabel || match.league?.name || "";
  return el("a", {
    class: `card${changed ? " flash" : ""}`,
    href: kind === "live" ? `/watch/${match.id}` : `/match.html?id=${match.id}`,
    "data-match-id": match.id,
    "data-kind": kind,
  }, [
    el("div", { class: "card-top" }, [
      options.showLeague
        ? el("span", { class: "comp" }, [
          match.league?.logo ? logo(match.league.logo, leagueLabel, "league-logo") : null,
          leagueLabel,
        ])
        : el("span", {}, match.league?.round || ""),
      kind === "live"
        ? el("span", { class: "live-meta" }, liveStatusNodes(match))
        : el("span", { class: "status-label" }, cardStatus(match)),
    ]),
    el("div", { class: "card-main" }, [
      teamBlock(match.away, "away"),
      scoreBlock(match, timeZone),
      teamBlock(match.home, "home"),
    ]),
    eventFooter(match),
  ]);
}

export function updateMatchCard(card, match, timeZone, changed) {
  const kind = cardKind(match);
  if (!card || card.dataset.kind !== kind) return false;
  const statusNode = card.querySelector(".live-status");
  const minuteText = minuteLabel(match.status);
  const minute = card.querySelector(".live-minute");
  if (kind === "live" && (!statusNode || Boolean(minuteText) !== Boolean(minute))) return false;
  if (statusNode) statusNode.textContent = cardStatus(match);
  if (minute) minute.textContent = minuteText;
  const label = card.querySelector(".status-label");
  if (label) label.textContent = cardStatus(match);
  const nums = [...card.querySelectorAll(".score-num")];
  if (hasScore(match.goals) && nums.length === 2) {
    const away = String(match.goals.away);
    const home = String(match.goals.home);
    if (nums[0].textContent !== away || nums[1].textContent !== home) {
      nums[0].textContent = away;
      nums[1].textContent = home;
      if (changed) flash(card);
    }
    const extra = scoreNote(match);
    const sub = card.querySelector(".score-sub");
    if (sub && extra) sub.textContent = extra;
    else if (sub && !extra) sub.remove();
    else if (!sub && extra) card.querySelector(".score")?.append(el("div", { class: "score-sub" }, extra));
    return true;
  }
  card.querySelector(".score")?.replaceWith(scoreBlock(match, timeZone));
  if (changed) flash(card);
  return true;
}

function flash(card) {
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

function teamBlock(team, side) {
  return el("div", { class: `team ${side}` }, [
    logo(team.logo, team.name, "logo"),
    el("span", { class: "team-name" }, team.name),
  ]);
}

function scoreBlock(match, timeZone) {
  if (!hasScore(match.goals)) {
    return el("div", { class: "score" }, [
      el("div", { class: "score-time" }, kickoffTime(match.kickoff, timeZone)),
      el("div", { class: "score-sub" }, "توقيت المغرب"),
    ]);
  }
  const extra = scoreNote(match);
  return el("div", { class: "score" }, [
    el("div", { class: "score-line" }, [
      el("span", { class: "score-num" }, String(match.goals.away)),
      el("span", {}, "–"),
      el("span", { class: "score-num" }, String(match.goals.home)),
    ]),
    extra ? el("div", { class: "score-sub" }, extra) : null,
  ]);
}

function liveStatusNodes(match) {
  const minute = minuteLabel(match.status);
  return [
    el("span", { class: "live-dot" }, "LIVE"),
    el("span", { class: "live-status" }, statusLabel(match.status)),
    minute ? el("span", { class: "live-minute" }, minute) : null,
  ];
}

function scoreNote(match) {
  if (match.score?.pen) return `ترجيح المضيف ${match.score.pen.home} والضيف ${match.score.pen.away}`;
  if (match.score?.ht && statusKind(match.status.short) === "live") {
    return `الشوط الأول ${match.score.ht.away}-${match.score.ht.home}`;
  }
  return "";
}

function eventFooter(match) {
  const summary = match.eventSummary;
  if (!summary) return null;
  const homeGoals = namedGoals(summary.goals, "home");
  const awayGoals = namedGoals(summary.goals, "away");
  const cards = summary.cards;
  const any = homeGoals.length || awayGoals.length || cards.home.yellow || cards.home.red || cards.away.yellow || cards.away.red;
  if (!any) return null;
  return el("div", { class: "events" }, [
    sideEvents(awayGoals, cards.away, "away"),
    sideEvents(homeGoals, cards.home, "home"),
  ]);
}

function namedGoals(goals, side) {
  return (goals || []).filter((goal) => goal.side === side).map(goalLine).filter(Boolean);
}

function goalLine(goal) {
  const name = knownPlayer(goal.player);
  if (!name) return "";
  const minute = goal.minute == null ? "" : minuteText(goal.minute, goal.extra);
  return [minute, name].filter(Boolean).join(" ");
}

function sideEvents(lines, cards, side) {
  return el("div", { class: side }, [
    lines.length ? el("ul", {}, lines.map((line) => el("li", {}, line))) : null,
    cards.yellow || cards.red ? el("div", {}, [
      cards.yellow ? el("span", { class: "dot yellow" }, String(cards.yellow)) : null,
      cards.red ? el("span", { class: "dot red" }, String(cards.red)) : null,
    ]) : null,
  ]);
}

export function groupSection(group, timeZone, changed) {
  return el("section", { class: "group" }, [
    el("h2", {}, [
      group.logo ? logo(group.logo, group.label, "league-logo") : null,
      group.label,
    ]),
    el("div", { class: "cards" }, group.matches.map((match) => matchCard(match, timeZone, changed.has(match.id)))),
  ]);
}

export function hero(match, timeZone) {
  return el("section", { class: "hero" }, [
    teamBlock(match.away, "away"),
    scoreBlock(match, timeZone),
    teamBlock(match.home, "home"),
  ]);
}

export function eventTimeline(events, error) {
  if (error) return el("p", { class: "section-error" }, error);
  const visible = (events || []).filter((event) => {
    const goal = event.type === "Goal" && event.detail !== "Missed Penalty";
    return !goal || knownPlayer(event.player);
  });
  if (!visible.length) return el("p", { class: "section-error" }, "لم تُرجع الواجهة أحداثاً لهذه المباراة.");
  return el("ol", { class: "timeline" }, visible.map((event) => el("li", {}, [
    el("span", { class: "minute" }, event.minute == null ? "" : minuteText(event.minute, event.extra)),
    event.team?.logo ? logo(event.team.logo, event.team.name || "", "league-logo") : el("span", {}, ""),
    el("span", {}, [event.detail || event.type, knownPlayer(event.player), knownPlayer(event.assist)].filter(Boolean).join(" — ")),
  ])));
}

export function statsBlock(statistics, error) {
  if (error) return el("p", { class: "section-error" }, error);
  if (!statistics || statistics.length < 2) return el("p", { class: "section-error" }, "لا توجد إحصائيات من الواجهة.");
  const away = new Map(statistics[1].stats.map((item) => [item.type, item.value]));
  return el("div", {}, statistics[0].stats.map((item) => statRow(item.type, item.value, away.get(item.type) ?? null)));
}

function statRow(type, home, away) {
  const homeNum = numeric(home);
  const awayNum = numeric(away);
  let homeWidth = 0;
  let awayWidth = 0;
  if (homeNum != null && awayNum != null) {
    if (String(home).includes("%") || String(away).includes("%")) {
      homeWidth = homeNum;
      awayWidth = awayNum;
    } else {
      const total = homeNum + awayNum;
      homeWidth = total ? (homeNum / total) * 100 : 0;
      awayWidth = total ? (awayNum / total) * 100 : 0;
    }
  }
  return el("div", {}, [
    el("div", { class: "stat-label" }, type),
    el("div", { class: "stat-row" }, [
      el("b", {}, home == null || home === "" ? "—" : String(home)),
      el("div", { class: "bar" }, [
        el("i", {}, [el("b", { style: `width:${homeWidth}%` })]),
        el("i", { class: "away" }, [el("b", { style: `width:${awayWidth}%` })]),
      ]),
      el("span", {}, away == null || away === "" ? "—" : String(away)),
    ]),
  ]);
}

function numeric(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const match = value.replace("%", "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function lineupsBlock(lineups, match, error) {
  if (error) return el("p", { class: "section-error" }, error);
  if (!lineups?.length) return el("p", { class: "section-error" }, "لم تُرجع الواجهة تشكيلة.");
  return el("div", {}, lineups.map((lineup) => {
    const side = lineup.team.id === match.away.id ? "away" : "home";
    const gridded = lineup.startXI.length > 0 && lineup.startXI.every((player) => player.grid);
    return el("section", {}, [
      el("h3", {}, `${lineup.team.name}${lineup.formation ? ` · ${lineup.formation}` : ""}`),
      lineup.coach ? el("p", { class: "window" }, `المدرب: ${lineup.coach}`) : null,
      gridded ? pitch(lineup.startXI, side) : el("div", { class: "xi-list" }, lineup.startXI.map((player) => el("span", {}, playerText(player)))),
      lineup.substitutes.length ? el("div", { class: "subs" }, lineup.substitutes.map((player) => el("span", {}, playerText(player)))) : null,
    ]);
  }));
}

function pitch(players, side) {
  const placed = players.map((player) => {
    const [row, col] = player.grid.split(":").map(Number);
    return { ...player, row, col };
  });
  const maxRow = Math.max(...placed.map((player) => player.row));
  const maxCol = Math.max(...placed.map((player) => player.col));
  return el("div", { class: "pitch" }, placed.map((player) => {
    const x = ((player.col - 0.5) / maxCol) * 100;
    const depth = (player.row - 0.5) / maxRow;
    const y = side === "home" ? 100 - depth * 46 - 4 : depth * 46 + 4;
    return el("div", { class: "player", style: `left:${x}%;top:${y}%` }, [
      el("div", { class: "num" }, player.number == null ? "·" : String(player.number)),
      player.name,
    ]);
  }));
}

function playerText(player) {
  return `${player.number == null ? "" : `${player.number} `}${player.name}`;
}

export function standingsBlock(standings, error) {
  if (error) return el("p", { class: "section-error" }, error);
  if (!standings?.groups?.length) return el("p", { class: "section-error" }, "لا يوجد ترتيب من الواجهة.");
  return el("div", {}, standings.groups.map((group) => el("section", {}, [
    group.name ? el("h3", {}, group.name) : null,
    el("div", { class: "table-wrap" }, [
      el("table", {}, [
        el("thead", {}, [el("tr", {}, ["#", "الفريق", "ل", "ف", "ت", "خ", "ف.أ", "ن", "آخر"].map((label, index) => el("th", { class: index === 1 ? "" : "num" }, label)))]),
        el("tbody", {}, group.rows.map((row) => el("tr", {}, [
          el("td", { class: "num" }, row.rank == null ? "—" : String(row.rank)),
          el("td", { class: "team-cell" }, [logo(row.team.logo, row.team.name, "league-logo"), row.team.name]),
          ...[row.played, row.win, row.draw, row.lose, row.gd, row.points].map((value) => el("td", { class: "num" }, value == null ? "—" : String(value))),
          el("td", {}, formPills(row.form)),
        ]))),
      ]),
    ]),
  ])));
}

function formPills(form) {
  if (!form) return "—";
  return el("span", { class: "form" }, [...form].slice(0, 5).map((letter) => el("i", { class: `form-${letter.toLowerCase()}` }, letter)));
}
