export function openLiveFeed(onSync) {
  const source = new EventSource("/api/live/feed");
  source.addEventListener("sync", (event) => {
    try {
      onSync(JSON.parse(event.data));
    } catch {
      // A bad event leaves the last rendered scores in place.
    }
  });
  return () => source.close();
}
