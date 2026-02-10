/**
 * Unread routes — aggregate unread counts across teams and conversations.
 *
 * GET /unread — Get unread counts
 */

import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  teamMembers,
  tez,
  tezRecipients,
  conversationMembers,
} from "../db/index.js";
import { authenticate } from "../middleware/auth.js";

export const unreadRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /unread — Get unread counts
// ─────────────────────────────────────────────────────────────────────────────

unreadRoutes.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;

    // 1. Team unread: tez_recipients where readAt is null for this user
    const teamMemberships = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId));

    const teamUnreads: Array<{ teamId: string; count: number }> = [];

    for (const { teamId } of teamMemberships) {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(tezRecipients)
        .innerJoin(tez, eq(tezRecipients.tezId, tez.id))
        .where(
          and(
            eq(tezRecipients.userId, userId),
            sql`${tezRecipients.readAt} IS NULL`,
            eq(tez.teamId, teamId),
            eq(tez.status, "active")
          )
        );

      const count = rows[0]?.count ?? 0;
      if (count > 0) {
        teamUnreads.push({ teamId, count });
      }
    }

    // 2. Conversation unread: messages after lastReadAt
    const convMemberships = await db
      .select({
        conversationId: conversationMembers.conversationId,
        lastReadAt: conversationMembers.lastReadAt,
      })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, userId));

    const convUnreads: Array<{ conversationId: string; count: number }> = [];

    for (const { conversationId, lastReadAt } of convMemberships) {
      let rows;
      if (lastReadAt) {
        rows = await db
          .select({ count: sql<number>`count(*)` })
          .from(tez)
          .where(
            and(
              eq(tez.conversationId, conversationId),
              eq(tez.status, "active"),
              sql`${tez.createdAt} > ${lastReadAt}`
            )
          );
      } else {
        // Never read — count all messages
        rows = await db
          .select({ count: sql<number>`count(*)` })
          .from(tez)
          .where(
            and(
              eq(tez.conversationId, conversationId),
              eq(tez.status, "active")
            )
          );
      }

      const count = rows[0]?.count ?? 0;
      if (count > 0) {
        convUnreads.push({ conversationId, count });
      }
    }

    const total =
      teamUnreads.reduce((sum, t) => sum + t.count, 0) +
      convUnreads.reduce((sum, c) => sum + c.count, 0);

    res.json({
      data: {
        teams: teamUnreads,
        conversations: convUnreads,
        total,
      },
    });
  } catch (err) {
    console.error("Unread counts error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get unread counts" } });
  }
});
