import { getNews } from "./api.js";
import { el } from "./components.js";
import { clockTime } from "./format.js";

const syncNode = document.querySelector("#sync");
const sourceNode = document.querySelector("#source");
const listNode = document.querySelector("#list");

boot();

async function boot() {
  try {
    const data = await getNews();
    const when = data.fetchedAt ? clockTime(data.fetchedAt, "Africa/Casablanca") : "";
    syncNode.textContent = when ? `آخر جلب للموجز: ${when} بتوقيت المغرب` : "تم جلب الموجز";
    sourceNode.replaceChildren(
      "المصدر: ",
      el("a", { href: data.sourceUrl, target: "_blank", rel: "noreferrer" }, data.source),
      data.footballOnly
        ? ". العناوين المرتبطة بكرة القدم فقط، والمقال الكامل لدى الناشر."
        : ". الموجز الرياضي لم يحتوِ عناوين كرة واضحة، وهذه عناوينه الرياضية كما وردت."
    );
    if (!data.items?.length) {
      listNode.replaceChildren(el("p", { class: "empty" }, "الموجز لم يُرجع عناوين."));
      return;
    }
    listNode.replaceChildren(...data.items.map((item) => el("article", { class: "news-card" }, [
      el("h2", {}, item.title),
      item.excerpt ? el("p", {}, item.excerpt) : null,
      el("p", { class: "source" }, [
        item.publishedAt ? `${item.publishedAt} · ` : "",
        el("a", { href: item.url, target: "_blank", rel: "noreferrer" }, "اقرأ المقال في المصدر"),
      ]),
    ])));
  } catch (error) {
    syncNode.textContent = "تعذر تحميل الأخبار";
    listNode.replaceChildren(el("p", { class: "empty" }, error.message || "الموجز غير متاح. لم تُنشأ أخبار بديلة."));
  }
}
