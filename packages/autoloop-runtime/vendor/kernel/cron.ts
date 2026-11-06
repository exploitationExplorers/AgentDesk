// Five-field cron in the rules' time zone: when the next one comes. As in cron, a day of the month and a day of the
// week both given take either, but when either starts with * a day must match both; 0 and 7 are Sunday. A wall-clock
// moment that doesn't exist (clocks going forward) is skipped, and one that happens twice (clocks going back) counts
// the first time, so a schedule fires at most once per wall-clock moment.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Far enough for a leap day; a schedule with nothing in it never comes. */
const HORIZON = 8 * 366;
/** What each of the five fields may hold. */
const LOWEST = [0, 0, 1, 1, 0];
const HIGHEST = [59, 23, 31, 12, 7];

function field(text: string, min: number, max: number) {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, all, from, to, step] = match;
    const start = all === "*" ? min : Number(from);
    const end = all === "*" ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step === undefined ? 1 : Number(step);
    if (start < min || end > max || start > end || by < 1) return null;
    for (let value = start; value <= end; value += by) values.add(value);
  }
  return values;
}

export function parseCron(text: string) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, index) => field(part, LOWEST[index], HIGHEST[index]));
  if (sets.some((set) => set === null)) return null;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  if (weekdays.delete(7)) weekdays.add(0);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  const anyDay = parts[2].startsWith("*");
  const anyWeekday = parts[4].startsWith("*");
  return { minutes: sorted(minutes), hours: sorted(hours), days, months, weekdays, anyDay, anyWeekday };
}

export type Cron = NonNullable<ReturnType<typeof parseCron>>;
const formats = new Map<string, Intl.DateTimeFormat>();

function wallClock(ms: number, zone: string) {
  let format = formats.get(zone);
  if (!format) {
    const fields = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" } as const;
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", ...fields });
    formats.set(zone, format);
  }
  return Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
}

/** How far the zone's clock is ahead of UTC at this moment. */
function offset(ms: number, zone: string) {
  const clock = wallClock(ms, zone);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

/** The first moment this zone's clock reads this, or null if it never does. */
function moment(year: number, month: number, day: number, hour: number, minute: number, zone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const tries = [...new Set([guess - offset(guess - DAY, zone), guess - offset(guess + DAY, zone)])];
  const matches = (at: number) => {
    const clock = wallClock(at, zone);
    return clock.day === day && clock.hour === hour && clock.minute === minute;
  };
  return tries.sort((a, b) => a - b).find(matches) ?? null;
}

/** The first minute strictly after `after` that the schedule names, or null if it never comes. */
export function nextRun(cron: Cron, after: number, zone: string): number | null {
  const start = wallClock(after, zone);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  for (let dayIndex = 0; dayIndex < HORIZON; dayIndex++) {
    const date = new Date(first + dayIndex * DAY);
    if (!cron.months.has(date.getUTCMonth() + 1)) continue;
    const onDay = cron.days.has(date.getUTCDate());
    const onWeekday = cron.weekdays.has(date.getUTCDay());
    if (!(cron.anyDay || cron.anyWeekday ? onDay && onWeekday : onDay || onWeekday)) continue;
    for (const hour of cron.hours) {
      if (dayIndex === 0 && hour < start.hour) continue;
      for (const minute of cron.minutes) {
        // Earlier on the first day has already happened: a moment counts the first time the clock reads it.
        if (dayIndex === 0 && hour === start.hour && minute < start.minute) continue;
        const at = moment(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, zone);
        if (at !== null && at > after) return at;
      }
    }
  }
  return null;
}

/** The last time due at or before `now`, given that `due` was due: what a hub asleep for a while still owes, once. */
export function latestBefore(cron: Cron, due: number, now: number, zone: string) {
  // Looks back over ever wider windows, so a minutely schedule after a year asleep doesn't walk the year.
  for (const window of [HOUR, DAY, 32 * DAY, 400 * DAY, Infinity]) {
    let latest: number | null = null;
    let at: number | null = window === Infinity || now - window < due ? due : nextRun(cron, now - window, zone);
    while (at !== null && at <= now) {
      latest = at;
      at = nextRun(cron, at, zone);
    }
    if (latest !== null) return latest;
  }
  return due;
}

export function dayStart(now: number, zone: string) {
  const clock = wallClock(now, zone);
  return moment(clock.year, clock.month, clock.day, 0, 0, zone) ?? now;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六", "日"];

/** A common schedule in plain words (每天 18:00, 每周日 06:00, 工作日 09:00, 每月 1 日 04:00); any other as written. */
export function describeCron(text: string) {
  const [minute, hour, day, month, weekday] = text.trim().split(/\s+/);
  const number = /^\d+$/;
  if (!number.test(minute) || !number.test(hour) || month !== "*" || !parseCron(text)) return text;
  const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && weekday === "*") return `每天 ${at}`;
  if (day === "*" && number.test(weekday)) return `每周${WEEKDAYS[Number(weekday)]} ${at}`;
  if (day === "*" && weekday === "1-5") return `工作日 ${at}`;
  if (number.test(day) && weekday === "*") return `每月 ${Number(day)} 日 ${at}`;
  return text;
}
