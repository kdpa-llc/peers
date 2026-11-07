/** Relative and short absolute times. */

export function ago(isoTime: string | undefined, now = Date.now()): string {
  if (!isoTime) return "";
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function clock(isoTime: string): string {
  const d = new Date(isoTime);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
