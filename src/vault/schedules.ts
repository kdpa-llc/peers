/**
 * Schedule slot arithmetic (ADR 0003, CONTRACT_TESTS #2).
 *
 * A slot is the instant a schedule is due. `latestSlot` returns the most recent slot at or
 * before `now`; the vault fires a schedule when that slot is newer than the last one it
 * recorded. Wall-clock times are interpreted in the schedule's IANA time zone with
 * `Intl.DateTimeFormat`, so daylight-saving changes move the instant, not the local time.
 *
 * Pure functions of their arguments: no clock is read here.
 */
export type Schedule = {
  id: string;
  every: "minutes" | "hours" | "day" | "weekday" | "week";
  n?: number;
  /** "HH:MM", local time in `tz`. */
  at?: string;
  day?: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  tz?: string;
  prompt: string;
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Parts = { y: number; m: number; d: number; hh: number; mm: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function partsIn(tz: string, at: Date): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(at)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year!, m: out.month!, d: out.day!, hh: out.hour! % 24, mm: out.minute! };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(tz: string, at: Date): number {
  const p = partsIn(tz, at);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return Math.round((asUtc - Math.floor(at.getTime() / MINUTE) * MINUTE) / MINUTE);
}

/** The instant a local wall-clock time occurs in a zone (the later one in a DST gap). */
export function zonedTime(tz: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const local = Date.UTC(y, m - 1, d, hh, mm);
  let t = local;
  for (let i = 0; i < 3; i++) t = local - offsetMinutes(tz, new Date(t)) * MINUTE;
  return new Date(t);
}

export function validTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    formatter(tz);
    return tz;
  } catch {
    return "UTC";
  }
}

/** The most recent instant at or before `now` when the schedule was due. */
export function latestSlot(s: Schedule, now: Date): Date | undefined {
  const tz = validTimeZone(s.tz);
  const t = now.getTime();
  if (s.every === "minutes") {
    const step = Math.max(1, s.n ?? 30) * MINUTE;
    return new Date(Math.floor(t / step) * step);
  }
  const today = partsIn(tz, now);
  if (s.every === "hours") {
    const step = Math.max(1, s.n ?? 1) * HOUR;
    const midnight = zonedTime(tz, today.y, today.m, today.d, 0, 0).getTime();
    return new Date(midnight + Math.floor((t - midnight) / step) * step);
  }
  const [hh, mm] = (/^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.at ?? "09:00") ?? [, "09", "00"])
    .slice(1).map(Number) as [number, number];
  for (let back = 0; back <= 8; back++) {
    // Calendar arithmetic on the local date; Date.UTC normalises day underflow.
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d - back));
    const weekday = WEEKDAYS[day.getUTCDay()]!;
    if (s.every === "weekday" && (weekday === "sat" || weekday === "sun")) continue;
    if (s.every === "week" && weekday !== (s.day ?? "mon")) continue;
    const candidate = zonedTime(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
    if (candidate.getTime() <= t) return candidate;
  }
  return undefined;
}

/** The next slot strictly after `now`, for "next run" labels. */
export function nextSlot(s: Schedule, now: Date): Date | undefined {
  // Search forward in coarse steps; good enough for display and cheap.
  const horizon = s.every === "week" ? 8 * 24 * HOUR : s.every === "minutes" ? 25 * HOUR : 4 * 24 * HOUR;
  const latest = latestSlot(s, now)?.getTime() ?? now.getTime();
  const step = s.every === "minutes" ? Math.max(1, s.n ?? 30) * MINUTE : 15 * MINUTE;
  for (let probe = now.getTime() + step; probe <= now.getTime() + horizon; probe += step) {
    const slot = latestSlot(s, new Date(probe));
    if (slot && slot.getTime() > latest && slot.getTime() > now.getTime()) return slot;
  }
  return undefined;
}

/** A sentence for a schedule, used in the UI and in task objectives. */
export function describeSchedule(s: Schedule): string {
  switch (s.every) {
    case "minutes": return `Every ${s.n ?? 30} minutes`;
    case "hours": return (s.n ?? 1) === 1 ? "Every hour" : `Every ${s.n} hours`;
    case "day": return `Every day at ${s.at ?? "09:00"}`;
    case "weekday": return `Every weekday at ${s.at ?? "09:00"}`;
    case "week": return `Every ${capital(s.day ?? "mon")} at ${s.at ?? "09:00"}`;
  }
}

function capital(day: string): string {
  return ({ mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as Record<string, string>)[day] ?? day;
}
