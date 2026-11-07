/**
 * Live events over SSE. The browser resends Last-Event-ID on reconnect; the server answers
 * with the missed events or `resync` (TECHNICAL.md §11). Returning to the foreground also
 * resyncs, because a phone may have slept through anything.
 */

export type LiveHandlers = {
  onEvent(type: string, data: any): void;
  onResync(): void;
  onStatus(status: "live" | "connecting" | "offline"): void;
};

const TYPES = [
  "file.changed", "tree.changed", "thread.updated", "bots.changed", "annotation.updated",
  "seen.changed", "today.changed", "state.changed",
];

export function connect(h: LiveHandlers): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let failures = 0;
  const open = (): void => {
    if (closed) return;
    h.onStatus("connecting");
    source = new EventSource("/api/events");
    source.addEventListener("hello", () => { failures = 0; h.onStatus("live"); });
    source.addEventListener("resync", () => h.onResync());
    for (const t of TYPES) {
      source.addEventListener(t, (e) => {
        let data: any = {};
        try { data = JSON.parse((e as MessageEvent).data); } catch { /* ignore */ }
        h.onEvent(t, data);
      });
    }
    source.onerror = () => {
      failures++;
      h.onStatus(failures > 2 ? "offline" : "connecting");
      if (source?.readyState === EventSource.CLOSED) {
        source = undefined;
        setTimeout(open, Math.min(15000, 1000 * failures));
      }
    };
  };
  open();
  const onVisible = (): void => {
    if (document.visibilityState === "visible") h.onResync();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    closed = true;
    source?.close();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
