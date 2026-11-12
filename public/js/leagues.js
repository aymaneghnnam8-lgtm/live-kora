import { getCompetition, getStatus } from "./api.js";
import { el, setupPanel, standingsBlock } from "./components.js";

const grid = document.querySelector("#grid");
const detail = document.querySelector("#detail");
const syncNode = document.querySelector("#sync");
const params = new URLSearchParams(location.search);

boot();

async function boot() {
  let status;
  try {
    status = await getStatus();
  } catch (error) {
    syncNode.textContent = "تعذر الاتصال بالخادم";
    grid.replaceChildren(el("p", { class: "empty" }, error.message));
    return;
  }

  grid.replaceChildren(...(status.leagues || []).map((league) => {
    const card = el("a", { class: "league-card", href: `/leagues.html?id=${league.id}` }, [
      el("h2", {}, league.nameAr),
      el("p", { class: "source" }, league.name),
      el("span", {}, "مباريات اليوم والترتيب"),
    ]);
    return card;
  }), el("a", { class: "league-card", href: "/?league=all" }, [
    el("h2", {}, "بطولات أخرى"),
    el("p", {}, "كل المباريات التي يعيدها API-Football لهذا اليوم، بأسمائها الأصلية."),
  ]));

  const id = params.get("id");
  if (!id) return;
  if (!status.configured) {
    detail.replaceChildren(setupPanel());
    return;
  }
  syncNode.textContent = "جارٍ طلب الترتيب…";
  try {
    const data = await getCompetition(id);
    const name = data.competition.nameAr || data.competition.name;
    detail.replaceChildren(
      el("section", { class: "panel" }, [
        el("h2", {}, name),
        el("p", { class: "source" }, [
          data.competition.name,
          data.competition.season ? ` · موسم ${data.competition.season}` : "",
          " · ",
          el("a", { href: `/?league=${data.competition.id}` }, "مباريات اليوم لهذه البطولة"),
        ]),
        standingsBlock(data.standings, data.errors?.standings),
      ])
    );
    syncNode.textContent = data.warning || "الترتيب من API-Football";
  } catch (error) {
    syncNode.textContent = "تعذر تحميل الترتيب";
    detail.replaceChildren(el("p", { class: "empty" }, error.code === "missing_api_key" ? "مفتاح API غير موجود." : error.message));
  }
}
