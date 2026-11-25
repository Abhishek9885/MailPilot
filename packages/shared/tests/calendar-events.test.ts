import { describe, expect, it } from "vitest";
import { CreateCalendarEventActionPayloadSchema } from "../src/index.js";

const validPayload = {
  title: "Review",
  startAt: "2027-02-01T04:30:00.000Z",
  endAt: "2027-02-01T05:30:00.000Z",
  startLocal: "2027-02-01T10:00",
  endLocal: "2027-02-01T11:00",
  timezone: "Asia/Kolkata",
  location: null,
  sourceEmailId: "f1d6b4df-eacf-4a18-a6e5-b036feac3388"
};

describe("calendar event payload validation", () => {
  it("accepts a unique local time in a valid IANA time zone", () => {
    expect(CreateCalendarEventActionPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it("rejects nonexistent daylight-saving local times", () => {
    expect(CreateCalendarEventActionPayloadSchema.safeParse({
      ...validPayload,
      startAt: "2026-03-08T07:30:00.000Z",
      endAt: "2026-03-08T08:00:00.000Z",
      startLocal: "2026-03-08T02:30",
      endLocal: "2026-03-08T04:00",
      timezone: "America/New_York"
    }).success).toBe(false);
  });

  it("rejects ambiguous daylight-saving local times", () => {
    expect(CreateCalendarEventActionPayloadSchema.safeParse({
      ...validPayload,
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T06:00:00.000Z",
      startLocal: "2026-11-01T01:30",
      endLocal: "2026-11-01T02:00",
      timezone: "America/New_York"
    }).success).toBe(false);
  });

  it("rejects invalid zones and nonpositive event duration", () => {
    expect(CreateCalendarEventActionPayloadSchema.safeParse({ ...validPayload, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(CreateCalendarEventActionPayloadSchema.safeParse({ ...validPayload, endAt: validPayload.startAt }).success).toBe(false);
  });
});
