import { describe, expect, it, vi } from "vitest";
import {
  isCommitmentReminderDue,
  isThreadStale,
  isWithinQuietHours,
  localDayInterval,
  nextAllowedTime,
  remainingDailySlots,
  withBoundedRetry
} from "../src/followups/scheduling.js";

describe("follow-up schedule calculations", () => {
  it("honors daytime quiet hours in the user's timezone", () => {
    const now = new Date("2026-01-14T06:30:00.000Z"); // 12:00 in Kolkata
    expect(isWithinQuietHours(now, "Asia/Kolkata", { start: 9, end: 17 })).toBe(true);
    expect(nextAllowedTime(now, "Asia/Kolkata", { start: 9, end: 17 }).toISOString())
      .toBe("2026-01-14T11:30:00.000Z"); // 17:00 in Kolkata
  });

  it("handles quiet hours that cross midnight", () => {
    const now = new Date("2026-01-14T17:00:00.000Z"); // 22:30 in Kolkata
    expect(isWithinQuietHours(now, "Asia/Kolkata", { start: 22, end: 7 })).toBe(true);
    expect(nextAllowedTime(now, "Asia/Kolkata", { start: 22, end: 7 }).toISOString())
      .toBe("2026-01-15T01:30:00.000Z");
  });

  it("leaves allowed times untouched and calculates DST-aware local days", () => {
    const allowed = new Date("2026-01-14T04:30:45.000Z");
    expect(nextAllowedTime(allowed, "Asia/Kolkata", { start: 22, end: 7 })).toEqual(allowed);
    const interval = localDayInterval(new Date("2026-03-08T16:00:00.000Z"), "America/New_York");
    expect(interval.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(interval.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("uses inclusive commitment lead and stale-thread thresholds", () => {
    const now = new Date("2026-02-10T12:00:00.000Z");
    expect(isCommitmentReminderDue(new Date("2026-02-11T12:00:00.000Z"), now, 24)).toBe(true);
    expect(isCommitmentReminderDue(new Date("2026-02-11T12:00:01.000Z"), now, 24)).toBe(false);
    expect(isCommitmentReminderDue(null, now, 24)).toBe(false);
    expect(isThreadStale(new Date("2026-02-05T12:00:00.000Z"), now, 5)).toBe(true);
    expect(isThreadStale(new Date("2026-02-05T12:00:01.000Z"), now, 5)).toBe(false);
  });

  it("does not exceed the configured per-day suggestion cap", () => {
    expect(remainingDailySlots(5, 0)).toBe(5);
    expect(remainingDailySlots(5, 4)).toBe(1);
    expect(remainingDailySlots(5, 5)).toBe(0);
    expect(remainingDailySlots(5, 7)).toBe(0);
  });

  it("rejects invalid or equal quiet-hour boundaries", () => {
    expect(() => isWithinQuietHours(new Date(), "UTC", { start: 4, end: 4 })).toThrow(RangeError);
    expect(() => nextAllowedTime(new Date(), "Not/AZone", { start: 4, end: 5 })).toThrow(RangeError);
  });
});

describe("bounded follow-up scan retries", () => {
  it("retries with deterministic capped exponential delays then succeeds", async () => {
    const waits: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => { waits.push(milliseconds); });
    let calls = 0;
    const result = await withBoundedRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary");
      return "scanned";
    }, { attempts: 4, baseDelayMs: 100, maxDelayMs: 150, sleep });

    expect(result).toBe("scanned");
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 150]);
  });

  it("stops after the configured attempts and returns the last failure", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(withBoundedRetry(async () => {
      calls += 1;
      throw new Error(`failure-${calls}`);
    }, { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: async (ms) => { waits.push(ms); } }))
      .rejects.toThrow("failure-3");
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });
});
