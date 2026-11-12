const LIVE = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);
const UPCOMING = new Set(["NS", "TBD", "PST"]);
const STATUS = {
  NS: "لم تبدأ",
  TBD: "غير محدد",
  PST: "مؤجلة",
  HT: "استراحة",
  "1H": "الشوط الأول",
  "2H": "الشوط الثاني",
  FT: "انتهت",
  AET: "بعد التمديد",
  PEN: "ترجيح",
  BT: "استراحة بين الأشواط الإضافية",
  P: "ترجيح",
  SUSP: "متوقفة",
  INT: "متوقفة",
  CANC: "ملغاة",
  ABD: "أُلغيت",
  AWD: "إداري",
  WO: "انسحاب",
  LIVE: "مباشر",
};

export function statusKind(short) {
  if (LIVE.has(short)) return "live";
  if (UPCOMING.has(short)) return "upcoming";
  return "finished";
}

export function statusLabel(status) {
  const short = status?.short || "";
  return STATUS[short] || short || "—";
}

export function minuteLabel(status) {
  const short = status?.short || "";
  if (!["1H", "2H", "ET", "LIVE"].includes(short) || status?.elapsed == null) return "";
  return status.extra ? `${status.elapsed}+${status.extra}'` : `${status.elapsed}'`;
}

export function knownPlayer(name) {
  const value = String(name || "").trim();
  if (!value || /^unknown player$/i.test(value)) return "";
  return value;
}

export function hasScore(goals) {
  return goals?.home != null && goals?.away != null;
}

export function moroccoToday(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function arabicDay(iso, timeZone) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-MA-u-nu-latn", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function kickoffTime(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-MA-u-nu-latn", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function clockTime(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-MA-u-nu-latn", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function ago(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `قبل ${seconds} ث`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `قبل ${minutes} د`;
  return `قبل ${Math.floor(minutes / 60)} س`;
}

export function minuteText(minute, extra) {
  if (minute == null) return "–";
  return extra ? `${minute}+${extra}'` : `${minute}'`;
}
