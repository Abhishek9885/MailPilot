import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { GmailOAuthTransaction } from "./types.js";

const GMAIL_OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const GmailOAuthTransactionSchema = z.object({
  state: z.string().min(32).max(256),
  nonce: z.string().min(32).max(256),
  codeVerifier: z.string().min(43).max(128),
  issuedAt: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  returnTo: z.string().max(64)
});

export function getGmailOAuthCookieName(secure: boolean): string {
  return secure ? "__Host-mailpilot_gmail_oauth" : "mailpilot_gmail_oauth";
}

export function signGmailOAuthTransaction(transaction: GmailOAuthTransaction, secret: string): string {
  const payload = Buffer.from(JSON.stringify(transaction)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyGmailOAuthTransaction(
  value: string | undefined,
  secret: string,
  now: Date
): GmailOAuthTransaction | null {
  if (!value || value.length > 4096) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!constantTimeEqual(sign(payload, secret), signature)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const result = GmailOAuthTransactionSchema.safeParse(parsed);
    if (!result.success) return null;
    const transaction = result.data;
    if (transaction.issuedAt > now.getTime() || now.getTime() - transaction.issuedAt > GMAIL_OAUTH_TRANSACTION_TTL_MS) {
      return null;
    }
    if (!isAllowedReturnPath(transaction.returnTo)) return null;
    return transaction;
  } catch {
    return null;
  }
}

export function normalizeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !isAllowedReturnPath(value)) return "/settings";
  return value;
}

function isAllowedReturnPath(value: string): boolean {
  return new Set(["/", "/inbox", "/drafts", "/approvals", "/tasks", "/archive", "/agent", "/activity", "/settings"]).has(value);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`mailpilot-gmail-oauth-v1.${payload}`).digest("base64url");
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}

