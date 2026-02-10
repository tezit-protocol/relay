/**
 * Conversation routes — DMs and group chats.
 *
 * POST /conversations              — Create DM or group
 * GET  /conversations              — List my conversations
 * GET  /conversations/:id/messages — Get messages in conversation
 * POST /conversations/:id/messages — Send message in conversation
 * POST /conversations/:id/read     — Mark conversation as read
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { eq, and, desc, lt, inArray, sql } from "drizzle-orm";
import { db, conversations, conversationMembers, tez, tezContext } from "../db/index.js";
import { authenticate } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";

export const conversationRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations — Create DM or group
// ─────────────────────────────────────────────────────────────────────────────

const CreateConversationSchema = z.object({
  type: z.enum(["dm", "group"]),
  memberIds: z.array(z.string()).min(1),
  name: z.string().min(1).max(100).optional(),
});

conversationRoutes.post("/", authenticate, async (req, res) => {
  try {
    const body = CreateConversationSchema.parse(req.body);
    const userId = req.user!.userId;
    const now = new Date().toISOString();

    // Ensure the creator is included in memberIds
    const allMembers = Array.from(new Set([userId, ...body.memberIds]));

    if (body.type === "dm") {
      // DM: exactly 2 members (including self)
      if (allMembers.length !== 2) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "DM requires exactly 2 members (including yourself)",
          },
        });
        return;
      }

      // Check for existing DM between these two users
      const otherUserId = allMembers.find((id) => id !== userId)!;
      const myConvos = await db
        .select({ conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(eq(conversationMembers.userId, userId));

      if (myConvos.length > 0) {
        const myConvoIds = myConvos.map((c) => c.conversationId);

        const otherConvos = await db
          .select({ conversationId: conversationMembers.conversationId })
          .from(conversationMembers)
          .where(
            and(
              inArray(conversationMembers.conversationId, myConvoIds),
              eq(conversationMembers.userId, otherUserId)
            )
          );

        if (otherConvos.length > 0) {
          // Check if any of the shared conversations are DMs
          const sharedConvoIds = otherConvos.map((c) => c.conversationId);
          const dmConvos = await db
            .select()
            .from(conversations)
            .where(
              and(
                inArray(conversations.id, sharedConvoIds),
                eq(conversations.type, "dm")
              )
            )
            .limit(1);

          if (dmConvos.length > 0) {
            // Return existing DM
            const existing = dmConvos[0];
            const members = await db
              .select()
              .from(conversationMembers)
              .where(eq(conversationMembers.conversationId, existing.id));

            res.status(201).json({
              data: { ...existing, members },
            });
            return;
          }
        }
      }
    }

    if (body.type === "group") {
      // Group: 2+ members (including self), name required
      if (allMembers.length < 2) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Group requires at least 2 members",
          },
        });
        return;
      }
      if (!body.name) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Group name is required",
          },
        });
        return;
      }
    }

    // Create conversation
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      type: body.type,
      name: body.name ?? null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    // Add all members
    for (const memberId of allMembers) {
      await db.insert(conversationMembers).values({
        conversationId,
        userId: memberId,
        joinedAt: now,
        lastReadAt: null,
      });
    }

    // Fetch complete conversation for response
    const conv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    const members = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));

    await recordAudit({
      actorUserId: userId,
      action: "conversation.created",
      targetType: "conversation",
      targetId: conversationId,
      metadata: { type: body.type, memberCount: allMembers.length },
    });

    res.status(201).json({
      data: { ...conv[0], members },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    console.error("Create conversation error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to create conversation" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations — List my conversations
// ─────────────────────────────────────────────────────────────────────────────

conversationRoutes.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 50);

    // Get conversation IDs the user is a member of
    const memberships = await db
      .select({
        conversationId: conversationMembers.conversationId,
        lastReadAt: conversationMembers.lastReadAt,
      })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, userId));

    if (memberships.length === 0) {
      res.json({ data: [] });
      return;
    }

    const convIds = memberships.map((m) => m.conversationId);
    const lastReadMap = new Map(
      memberships.map((m) => [m.conversationId, m.lastReadAt])
    );

    // Get conversations
    const convos = await db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, convIds))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);

    // For each conversation, get last message and unread count
    const result = await Promise.all(
      convos.map(async (conv) => {
        // Last message preview
        const lastMsg = await db
          .select({
            surfaceText: tez.surfaceText,
            senderUserId: tez.senderUserId,
            createdAt: tez.createdAt,
          })
          .from(tez)
          .where(and(eq(tez.conversationId, conv.id), eq(tez.status, "active")))
          .orderBy(desc(tez.createdAt))
          .limit(1);

        // Unread count
        const lastRead = lastReadMap.get(conv.id);
        let unreadCount = 0;
        if (lastRead) {
          const unreadRows = await db
            .select({ count: sql<number>`count(*)` })
            .from(tez)
            .where(
              and(
                eq(tez.conversationId, conv.id),
                eq(tez.status, "active"),
                sql`${tez.createdAt} > ${lastRead}`
              )
            );
          unreadCount = unreadRows[0]?.count ?? 0;
        } else {
          // Never read — count all messages
          const allRows = await db
            .select({ count: sql<number>`count(*)` })
            .from(tez)
            .where(
              and(eq(tez.conversationId, conv.id), eq(tez.status, "active"))
            );
          unreadCount = allRows[0]?.count ?? 0;
        }

        // Get members
        const members = await db
          .select()
          .from(conversationMembers)
          .where(eq(conversationMembers.conversationId, conv.id));

        return {
          ...conv,
          members,
          lastMessage: lastMsg[0] ?? null,
          unreadCount,
        };
      })
    );

    res.json({ data: result });
  } catch (err) {
    console.error("List conversations error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to list conversations" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations/:id/messages — Get messages in conversation
// ─────────────────────────────────────────────────────────────────────────────

conversationRoutes.get("/:id/messages", authenticate, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user!.userId;

    // Verify membership
    const membership = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId)
        )
      )
      .limit(1);

    if (membership.length === 0) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not a member of this conversation" } });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const before = req.query.before as string | undefined;

    let messages;
    if (before) {
      messages = await db
        .select()
        .from(tez)
        .where(
          and(
            eq(tez.conversationId, conversationId),
            eq(tez.status, "active"),
            lt(tez.createdAt, before)
          )
        )
        .orderBy(desc(tez.createdAt))
        .limit(limit);
    } else {
      messages = await db
        .select()
        .from(tez)
        .where(
          and(eq(tez.conversationId, conversationId), eq(tez.status, "active"))
        )
        .orderBy(desc(tez.createdAt))
        .limit(limit);
    }

    res.json({
      data: messages,
      meta: { count: messages.length, hasMore: messages.length === limit },
    });
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get messages" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations/:id/messages — Send message in conversation
// ─────────────────────────────────────────────────────────────────────────────

const SendMessageSchema = z.object({
  surfaceText: z.string().min(1).max(10000),
  type: z.enum(["note", "decision", "handoff", "question", "update"]).default("note"),
  urgency: z.enum(["critical", "high", "normal", "low", "fyi"]).default("normal"),
  context: z
    .array(
      z.object({
        layer: z.enum(["background", "fact", "artifact", "relationship", "constraint", "hint"]),
        content: z.string(),
        mimeType: z.string().optional(),
        confidence: z.number().min(0).max(100).optional(),
        source: z.enum(["stated", "inferred", "verified"]).optional(),
      })
    )
    .default([]),
});

conversationRoutes.post("/:id/messages", authenticate, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user!.userId;
    const body = SendMessageSchema.parse(req.body);

    // Verify membership
    const membership = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId)
        )
      )
      .limit(1);

    if (membership.length === 0) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not a member of this conversation" } });
      return;
    }

    // Verify conversation exists
    const conv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (conv.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Conversation not found" } });
      return;
    }

    const now = new Date().toISOString();
    const tezId = randomUUID();

    // Create the Tez in the conversation
    await db.insert(tez).values({
      id: tezId,
      teamId: null,
      conversationId,
      threadId: tezId,
      parentTezId: null,
      surfaceText: body.surfaceText,
      type: body.type,
      urgency: body.urgency,
      actionRequested: null,
      senderUserId: userId,
      visibility: conv[0].type === "dm" ? "dm" : "team",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Create context items
    for (const ctx of body.context) {
      await db.insert(tezContext).values({
        id: randomUUID(),
        tezId,
        layer: ctx.layer,
        content: ctx.content,
        mimeType: ctx.mimeType ?? null,
        confidence: ctx.confidence ?? null,
        source: ctx.source ?? null,
        derivedFrom: null,
        createdAt: now,
        createdBy: userId,
      });
    }

    // Update conversation updatedAt
    await db
      .update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, conversationId));

    await recordAudit({
      actorUserId: userId,
      action: "conversation.message_sent",
      targetType: "conversation",
      targetId: conversationId,
      metadata: { tezId, type: body.type },
    });

    res.status(201).json({
      data: {
        id: tezId,
        conversationId,
        surfaceText: body.surfaceText,
        type: body.type,
        senderUserId: userId,
        createdAt: now,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    console.error("Send message error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to send message" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /conversations/:id/read — Mark conversation as read
// ─────────────────────────────────────────────────────────────────────────────

conversationRoutes.post("/:id/read", authenticate, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user!.userId;
    const now = new Date().toISOString();

    // Verify membership
    const membership = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId)
        )
      )
      .limit(1);

    if (membership.length === 0) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not a member of this conversation" } });
      return;
    }

    await db
      .update(conversationMembers)
      .set({ lastReadAt: now })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId)
        )
      );

    await recordAudit({
      actorUserId: userId,
      action: "conversation.read",
      targetType: "conversation",
      targetId: conversationId,
    });

    res.json({ data: { success: true } });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to mark as read" } });
  }
});
