import { z } from "zod";

export const GMAIL_SYNC_QUEUE = "mailpilot-gmail-sync";
export const GMAIL_SYNC_JOB_NAME = "gmail.sync";
export const FOLLOW_UP_SCAN_QUEUE = "mailpilot-followup-scan";
export const FOLLOW_UP_SCAN_JOB_NAME = "followups.scan";
export const WORKER_HEARTBEAT_PREFIX = "mailpilot:worker:heartbeat:";

export const GmailSyncJobSchema = z.object({
  type: z.literal("gmail.sync"),
  userId: z.uuid(),
  syncId: z.uuid(),
  requestId: z.uuid()
}).strict();
export type GmailSyncJobPayload = z.infer<typeof GmailSyncJobSchema>;

export const FollowUpScanJobSchema = z.object({
  type: z.literal("followups.scan"),
  userId: z.uuid(),
  windowId: z.number().int().positive(),
  requestId: z.uuid()
}).strict();
export type FollowUpScanJobPayload = z.infer<typeof FollowUpScanJobSchema>;

export function gmailSyncQueueJobId(syncId: string): string {
  return `gmail-sync-${syncId}`;
}

export function followUpScanQueueJobId(userId: string, windowId: number): string {
  return `followups-${userId}-${windowId}`;
}
