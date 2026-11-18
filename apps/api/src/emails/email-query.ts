import {
  SyncedEmailListResponseSchema,
  type SyncedEmailListResponse
} from "@mailpilot/shared";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";

const ListLimitSchema = z.coerce.number().int().min(1).max(50).default(20);

export class EmailQueryService {
  public constructor(private readonly database: PrismaClient) {}

  public async list(userId: string, untrustedLimit: unknown): Promise<SyncedEmailListResponse> {
    const limit = ListLimitSchema.safeParse(untrustedLimit ?? 20);
    if (!limit.success) throw new ApiError(400, "INVALID_ARGUMENT", "Email list limit is invalid");
    const emails = await this.database.email.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      take: limit.data,
      select: {
        id: true,
        subject: true,
        senderName: true,
        senderEmailNormalized: true,
        receivedAt: true,
        labels: true,
        sourceRevision: true
      }
    });
    return SyncedEmailListResponseSchema.parse({
      emails: emails.map((email) => ({
        id: email.id,
        subject: Array.from(email.subject).slice(0, 2_000).join(""),
        senderName: email.senderName === null
          ? null
          : Array.from(email.senderName).slice(0, 320).join(""),
        senderEmail: email.senderEmailNormalized,
        receivedAt: email.receivedAt.toISOString(),
        labels: email.labels,
        sourceRevision: email.sourceRevision
      }))
    });
  }
}
