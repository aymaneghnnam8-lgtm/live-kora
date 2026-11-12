async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `فشل الطلب (${response.status}).`);
    error.code = body.error || "request_failed";
    throw error;
  }
  return body;
}

export const getStatus = () => getJson("/api/status");

export function getDay(date, league, refresh = false) {
  const query = new URLSearchParams({ date, league: String(league) });
  if (refresh) query.set("refresh", "1");
  return getJson(`/api/day?${query}`);
}

export function getLive(league, refresh = false) {
  const query = new URLSearchParams({ scope: "live", league: String(league) });
  if (refresh) query.set("refresh", "1");
  return getJson(`/api/matches?${query}`);
}

export const getNews = () => getJson("/api/news");

export function getCompetition(id) {
  return getJson(`/api/competitions/${id}`);
}

export function getMatch(id, refresh = false) {
  return getJson(`/api/matches/${id}${refresh ? "?refresh=1" : ""}`);
}
