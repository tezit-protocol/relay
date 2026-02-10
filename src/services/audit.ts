/**
 * Audit service — append-only log for every mutation.
 *
 * Every share, reply, read, delete, team change gets recorded.
 * This is the trust foundation: verifiable history of who did what.
 */

import { randomUUID } from "crypto";
import { db, auditLog } from "../db/index.js";

export type AuditAction =
  | "tez.shared"
  | "tez.replied"
  | "tez.read"
  | "tez.acknowledged"
  | "tez.archived"
  | "tez.deleted"
  | "team.created"
  | "team.member_added"
  | "team.member_removed"
  | "contact.registered"
  | "contact.updated"
  | "conversation.created"
  | "conversation.message_sent"
  | "conversation.read"
  | "federation.sent"
  | "federation.received"
  | "federation.failed";

export async function recordAudit(entry: {
  teamId?: string;
  actorUserId: string;
  action: AuditAction;
  targetType: "tez" | "team" | "contact" | "conversation";
  targetId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    id: randomUUID(),
    teamId: entry.teamId ?? "system",
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? null,
    createdAt: new Date().toISOString(),
  });
}
