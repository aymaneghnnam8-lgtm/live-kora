const FEED = {
  url: "https://www.france24.com/ar/sports/rss",
  source: "فرانس 24",
  sourceUrl: "https://www.france24.com/ar/رياضة/",
};

const OTHER_SPORT = /فورمولا|ملاكمة|تنس|كرة السلة|دراجات|ألعاب القوى|سباحة|غولف|رالي|هوكي|ركبي/;
const FOOTBALL = /كرة القدم|كرة قدم|مبار|دوري|منتخب|نادي|برشلون|ريال|أتلتيكو|اتلتيكو|وداد|رجاء|ليفربول|مانشستر|تشيلسي|أرسنال|يوفنت|ميلان|بايرن|باريس سان|فيفا|أبطال أوروبا|الليغا|بريمير|بوندس|كالتشيو|تصفيات|كأس|الكرة الذهبية|أفضل لاعب|تشكيلة|مدرب/;

let memory = null;

export function stripHtml(value) {
  return decode(String(value || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value, max = 160) {
  const text = stripHtml(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

export function isFootballNews(text) {
  const value = text || "";
  if (OTHER_SPORT.test(value)) return false;
  return FOOTBALL.test(value);
}

export function parseRss(xml, source) {
  const blocks = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const block of blocks) {
    if (items.length >= 20) break;
    const title = stripHtml(textTag(block, "title"));
    const link = textTag(block, "link");
    if (!title || !link) continue;
    let url;
    try {
      url = new URL(link.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    items.push({
      title,
      url: url.href,
      excerpt: truncate(textTag(block, "description")),
      publishedAt: textTag(block, "pubDate") || null,
      source,
    });
  }
  return items;
}

export async function getNews() {
  if (memory && Date.now() - memory.fetchedAt < 20 * 60 * 1000) return memory.payload;

  let response;
  try {
    response = await fetch(FEED.url, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
  } catch (cause) {
    const error = new Error(`تعذر الوصول إلى موجز الأخبار (${cause.message}).`);
    error.code = "upstream";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`موجز الأخبار أعاد الحالة ${response.status}.`);
    error.code = "upstream";
    throw error;
  }

  const xml = await response.text();
  const parsed = parseRss(xml, FEED.source);
  const football = parsed.filter((item) => isFootballNews(`${item.title} ${item.excerpt}`));
  const footballOnly = football.length > 0;
  const payload = {
    source: FEED.source,
    sourceUrl: FEED.sourceUrl,
    footballOnly,
    fetchedAt: new Date().toISOString(),
    items: (footballOnly ? football : parsed).slice(0, 12),
  };
  memory = { fetchedAt: Date.now(), payload };
  return payload;
}

function textTag(block, tag) {
  const wrapped = block.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i"));
  if (wrapped) return wrapped[1].trim();
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return plain ? plain[1].trim() : "";
}

function decode(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}
