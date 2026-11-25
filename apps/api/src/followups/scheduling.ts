export interface QuietHours {
  start: number | null;
  end: number | null;
}

export function isWithinQuietHours(at: Date, timeZone: string, quietHours: QuietHours): boolean {
  const { start, end } = quietHours;
  if (start === null || end === null) return false;
  if (start === end) throw new RangeError("Quiet hours must be shorter than one day");
  const local = localParts(at, timeZone);
  const minuteOfDay = local.hour * 60 + local.minute;
  const startMinute = start * 60;
  const endMinute = end * 60;
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

export function nextAllowedTime(at: Date, timeZone: string, quietHours: QuietHours): Date {
  if (!Number.isFinite(at.getTime())) throw new RangeError("Invalid current time");
  if (quietHours.start === null || quietHours.end === null) return new Date(at);
  if (!isWithinQuietHours(at, timeZone, quietHours)) return new Date(at);
  const candidate = new Date(at);
  candidate.setUTCSeconds(0, 0);
  if (candidate.getTime() < at.getTime()) candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let minute = 0; minute <= 2_880; minute += 1) {
    if (!isWithinQuietHours(candidate, timeZone, quietHours)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new RangeError("Could not find the end of quiet hours within 48 hours");
}

export function localDayInterval(at: Date, timeZone: string): { start: Date; end: Date } {
  const local = localParts(at, timeZone);
  const start = localDateTimeToUtc(local.year, local.month, local.day, 0, timeZone);
  const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const end = localDateTimeToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, timeZone);
  return { start, end };
}

export function isCommitmentReminderDue(dueAt: Date | null, now: Date, leadHours: number): boolean {
  return dueAt !== null && dueAt.getTime() - leadHours * 60 * 60 * 1_000 <= now.getTime();
}

export function isThreadStale(receivedAt: Date, now: Date, staleAfterDays: number): boolean {
  return receivedAt.getTime() + staleAfterDays * 24 * 60 * 60 * 1_000 <= now.getTime();
}

export function remainingDailySlots(dailyLimit: number, activatedToday: number): number {
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || !Number.isInteger(activatedToday) || activatedToday < 0) {
    throw new RangeError("Suggestion counts must be nonnegative integers");
  }
  return Math.max(0, dailyLimit - activatedToday);
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function withBoundedRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new RangeError("Retry attempts must be positive");
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      lastError = error;
      if (attempt === options.attempts) break;
      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** (attempt - 1)));
      await sleep(delay);
    }
  }
  throw lastError;
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute"))
  };
}

function localDateTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour);
  let guess = targetAsUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const local = localParts(new Date(guess), timeZone);
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour);
    const correction = targetAsUtc - representedAsUtc;
    if (correction === 0) break;
    guess += correction;
  }
  return new Date(guess);
}
