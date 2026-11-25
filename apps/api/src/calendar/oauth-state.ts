import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface CalendarOAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
  sessionId: string;
  userId: string;
  returnTo: string;
}

const CalendarOAuthTransactionSchema = z.object({
  state: z.string().min(32).max(256),
  nonce: z.string().min(32).max(256),
  codeVerifier: z.string().min(43).max(128),
  issuedAt: z.number().int().nonnegative(),
  sessionId: z.uuid(),
  userId: z.uuid(),
  returnTo: z.literal("/settings")
}).strict();

export function getCalendarOAuthCookieName(secure: boolean): string {
  return secure ? "__Host-mailpilot_calendar_oauth" : "mailpilot_calendar_oauth";
}

export function signCalendarOAuthTransaction(transaction: CalendarOAuthTransaction, secret: string): string {
  const payload = Buffer.from(JSON.stringify(transaction)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyCalendarOAuthTransaction(value: string | undefined, secret: string, now: Date): CalendarOAuthTransaction | null {
  if (!value || value.length > 4096) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  if (!constantTimeEqual(sign(payload, secret), value.slice(separator + 1))) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const transaction = CalendarOAuthTransactionSchema.safeParse(parsed);
    if (!transaction.success) return null;
    if (transaction.data.issuedAt > now.getTime() || now.getTime() - transaction.data.issuedAt > TRANSACTION_TTL_MS) return null;
    return transaction.data;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`mailpilot-calendar-oauth-v1.${payload}`).digest("base64url");
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}
