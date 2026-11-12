const syncNode = document.querySelector("#sync");
const loginNode = document.querySelector("#login");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const dashboard = document.querySelector("#dashboard");
const stateLine = document.querySelector("#state-line");
const runsTable = document.querySelector("#runs");
const changesTable = document.querySelector("#changes");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const token = String(new FormData(loginForm).get("token") || "");
  loginForm.reset();
  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    loginError.textContent = response.status === 503
      ? "لوحة الإدارة غير مهيأة على الخادم."
      : "تعذر الدخول.";
    if (body.error === "rate_limited") loginError.textContent = "محاولات كثيرة. أعد المحاولة لاحقاً.";
    return;
  }
  await refresh();
  connect();
});

for (const [id, action] of [["start", "start"], ["stop", "stop"], ["restart", "restart"]]) {
  document.querySelector(`#${id}`).addEventListener("click", () => command(action));
}

document.querySelector("#logout").addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" });
  feed?.close();
  showLogin();
});

let feed = null;
refresh();

async function refresh() {
  const response = await fetch("/api/admin/bot");
  if (response.status === 401) {
    showLogin();
    return;
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 503) {
    syncNode.textContent = "لوحة الإدارة غير مهيأة على الخادم.";
    loginNode.hidden = true;
    dashboard.hidden = true;
    return;
  }
  if (!response.ok) {
    syncNode.textContent = "تعذر قراءة حالة البوت.";
    return;
  }
  render(body);
  connect();
}

function connect() {
  if (feed) return;
  feed = new EventSource("/api/admin/feed");
  feed.addEventListener("sync", (event) => {
    try {
      render(JSON.parse(event.data));
    } catch {
      syncNode.textContent = "تعذر قراءة تحديث البوت.";
    }
  });
}

async function command(action) {
  const response = await fetch(`/api/admin/bot/${action}`, { method: "POST" });
  if (response.status === 401) {
    showLogin();
    return;
  }
  if (!response.ok) {
    syncNode.textContent = "تعذر تنفيذ الأمر.";
    return;
  }
  render(await response.json());
}

function showLogin() {
  loginNode.hidden = false;
  dashboard.hidden = true;
  syncNode.textContent = "يلزم تسجيل الدخول.";
}

function render(status) {
  loginNode.hidden = true;
  dashboard.hidden = false;
  const running = status.running && status.desired === "running";
  syncNode.textContent = running ? "البوت يعمل على الخادم." : "البوت متوقف.";
  const last = status.lastRun;
  stateLine.textContent = [
    `المباريات المباشرة المحفوظة: ${status.liveCount}`,
    last ? `آخر دورة: ${label(last.status)} · ${last.source || "—"} · جديد ${last.created_count} · محدث ${last.updated_count} · منتهٍ ${last.finished_count}` : "لا توجد دورة بعد.",
    last?.error ? `آخر خطأ: ${last.error}` : "",
  ].filter(Boolean).join(" ");
  renderTable(runsTable, ["الوقت", "الحالة", "المصدر", "جديد", "محدث", "منتهٍ", "محاولة", "خطأ"], (status.runs || []).map((run) => [
    time(run.finished_at || run.started_at),
    label(run.status),
    run.source || "—",
    run.created_count,
    run.updated_count,
    run.finished_count,
    run.attempt,
    run.error || "",
  ]));
  renderTable(changesTable, ["الوقت", "المباراة", "النوع", "الملخص"], (status.changes || []).map((change) => [
    time(change.at),
    change.fixture_id,
    kindLabel(change.kind),
    change.summary,
  ]));
}

function renderTable(table, headings, rows) {
  table.replaceChildren();
  const head = document.createElement("tr");
  for (const heading of headings) {
    const cell = document.createElement("th");
    cell.textContent = heading;
    head.append(cell);
  }
  table.append(head);
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = headings.length;
    cell.textContent = "لا توجد بيانات بعد.";
    row.append(cell);
    table.append(row);
    return;
  }
  for (const values of rows) {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value == null ? "" : String(value);
      row.append(cell);
    }
    table.append(row);
  }
}

function label(status) {
  if (status === "ok") return "نجحت";
  if (status === "failed") return "فشلت";
  if (status === "running") return "قيد التنفيذ";
  return status || "—";
}

function kindLabel(kind) {
  if (kind === "new") return "جديدة";
  if (kind === "updated") return "محدثة";
  if (kind === "finished") return "منتهية";
  return kind;
}

function time(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar-MA-u-nu-latn", {
    timeZone: "Africa/Casablanca",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}
