import tzLookup from "tz-lookup";

/** IANA time zone for the given coordinates, e.g. "Europe/Kyiv". */
export function resolveTimeZone(lat: number, lng: number): string {
  try {
    return tzLookup(lat, lng);
  } catch {
    // tz-lookup throws for coordinates with no defined zone (open ocean, far from any coastline).
    // Fall back to a plain longitude-based offset guess.
    const offsetHours = Math.round(-lng / 15);
    return offsetHours === 0 ? "Etc/GMT" : `Etc/GMT${offsetHours > 0 ? "+" : ""}${offsetHours}`;
  }
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatter.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFormatter.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock date/time that `date` reads as when displayed in `timeZone`. */
function wallTimeInZone(date: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hours: get("hour"),
    minutes: get("minute"),
  };
}

/**
 * Converts a wall-clock date/time meant as local time in `timeZone` into the UTC instant it
 * represents. Guesses the instant assuming UTC, then corrects by the offset between that guess
 * and the desired wall time. Doesn't iterate to resolve DST-transition instants exactly.
 */
export function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  const asShownInZone = wallTimeInZone(guess, timeZone);
  const shownAsUtc = Date.UTC(
    asShownInZone.year,
    asShownInZone.month - 1,
    asShownInZone.day,
    asShownInZone.hours,
    asShownInZone.minutes,
  );
  const offsetMs = guess.getTime() - shownAsUtc;
  return new Date(guess.getTime() + offsetMs);
}

/** Minutes since local midnight that `date` falls on, as displayed in `timeZone`. */
export function utcToZonedMinutesOfDay(date: Date, timeZone: string): number {
  const { hours, minutes } = wallTimeInZone(date, timeZone);
  return hours * 60 + minutes;
}

/** Short UTC offset label for `date` in `timeZone`, e.g. "UTC+3". */
export function formatUtcOffsetLabel(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
  const part = formatter.formatToParts(date).find((p) => p.type === "timeZoneName");
  return part?.value ?? "UTC";
}

/** `date`'s calendar date in `timeZone`, formatted as "YYYY-MM-DD" for a `<input type="date">`. */
export function formatZonedDateInput(date: Date, timeZone: string): string {
  const { year, month, day } = wallTimeInZone(date, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
