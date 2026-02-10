/**
 * ACL service — enforces team AND conversation membership.
 *
 * Rules:
 * - No query or write crosses team boundaries. Ever.
 * - No DM/conversation access without membership. Ever.
 */

import { db, teamMembers, conversationMembers, tezRecipients } from "../db/index.js";
import { eq, and } from "drizzle-orm";

export async function isTeamMember(
  userId: string,
  teamId: string
): Promise<boolean> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);

  return rows.length > 0;
}

export async function isTeamAdmin(
  userId: string,
  teamId: string
): Promise<boolean> {
  const rows = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);

  return rows.length > 0 && rows[0].role === "admin";
}

export async function assertTeamMember(
  userId: string,
  teamId: string
): Promise<void> {
  if (!(await isTeamMember(userId, teamId))) {
    const err = new Error("Not a member of this team");
    (err as NodeJS.ErrnoException).code = "FORBIDDEN";
    throw err;
  }
}

export async function isConversationMember(
  userId: string,
  conversationId: string
): Promise<boolean> {
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId)
      )
    )
    .limit(1);

  return rows.length > 0;
}

export async function assertConversationMember(
  userId: string,
  conversationId: string
): Promise<void> {
  if (!(await isConversationMember(userId, conversationId))) {
    const err = new Error("Not a member of this conversation");
    (err as NodeJS.ErrnoException).code = "FORBIDDEN";
    throw err;
  }
}

/**
 * Assert access to a tez based on its scope:
 * - If team-scoped: user must be a team member
 * - If conversation-scoped: user must be a conversation member
 * - If recipient: user is in tez_recipients (covers federated tez)
 * - If both team + conversation: must satisfy at least one
 * - If neither (orphan): only the sender or a recipient can access
 */
export async function assertTezAccess(
  userId: string,
  theTez: { id: string; teamId: string | null; conversationId: string | null; senderUserId: string }
): Promise<void> {
  // Sender always has access to their own tez
  if (theTez.senderUserId === userId) return;

  // Team-scoped: check team membership
  if (theTez.teamId) {
    if (await isTeamMember(userId, theTez.teamId)) return;
  }

  // Conversation-scoped: check conversation membership
  if (theTez.conversationId) {
    if (await isConversationMember(userId, theTez.conversationId)) return;
  }

  // Recipient check (covers federated tez with no team/conversation)
  const recipientRows = await db
    .select({ userId: tezRecipients.userId })
    .from(tezRecipients)
    .where(and(eq(tezRecipients.tezId, theTez.id), eq(tezRecipients.userId, userId)))
    .limit(1);
  if (recipientRows.length > 0) return;

  // No valid access path found
  const err = new Error("Access denied");
  (err as NodeJS.ErrnoException).code = "FORBIDDEN";
  throw err;
}
