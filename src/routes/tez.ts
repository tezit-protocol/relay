/**
 * Tez routes — the core API surface.
 *
 * POST /tez/share        — Send a Tez (create + deliver)
 * GET  /tez/stream       — Get feed for authenticated user
 * POST /tez/:id/reply    — Reply to a Tez (threaded)
 * GET  /tez/:id          — Get full Tez with context + provenance
 * GET  /tez/:id/thread   — Get full thread
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { eq, and, desc, inArray, or } from "drizzle-orm";
import { db, tez, tezContext, tezRecipients, contacts } from "../db/index.js";
import { authenticate } from "../middleware/auth.js";
import { assertTeamMember, assertTezAccess } from "../services/acl.js";
import { recordAudit } from "../services/audit.js";
import { config } from "../config.js";
import { partitionRecipients, routeToFederation } from "../services/federationOutbound.js";

export const tezRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /tez/share — Send a Tez
// ─────────────────────────────────────────────────────────────────────────────

const ShareSchema = z.object({
  id: z.string().uuid().optional(),
  teamId: z.string().uuid(),
  surfaceText: z.string().min(1).max(10000),
  type: z.enum(["note", "decision", "handoff", "question", "update"]).default("note"),
  urgency: z.enum(["critical", "high", "normal", "low", "fyi"]).default("normal"),
  actionRequested: z.string().max(500).optional(),
  visibility: z.enum(["team", "dm", "private"]).default("team"),
  recipients: z.array(z.string()).min(0).max(100).default([]),
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

tezRoutes.post("/share", authenticate, async (req, res) => {
  try {
    const body = ShareSchema.parse(req.body);
    const userId = req.user!.userId;

    // ACL: sender must be team member
    await assertTeamMember(userId, body.teamId);

    const now = new Date().toISOString();
    const tezId = body.id || randomUUID();
    const threadId = tezId; // root of a new thread

    // 1. Create the Tez
    await db.insert(tez).values({
      id: tezId,
      teamId: body.teamId,
      threadId,
      parentTezId: null,
      surfaceText: body.surfaceText,
      type: body.type,
      urgency: body.urgency,
      actionRequested: body.actionRequested ?? null,
      senderUserId: userId,
      visibility: body.visibility,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // 2. Create context items (the iceberg)
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

    // 3. Record recipients
    for (const recipientId of body.recipients) {
      await db.insert(tezRecipients).values({
        tezId,
        userId: recipientId,
        deliveredAt: now,
        readAt: null,
        acknowledgedAt: null,
      });
    }

    // 4. Audit
    await recordAudit({
      teamId: body.teamId,
      actorUserId: userId,
      action: "tez.shared",
      targetType: "tez",
      targetId: tezId,
      metadata: {
        type: body.type,
        visibility: body.visibility,
        recipientCount: body.recipients.length,
        contextLayerCount: body.context.length,
      },
    });

    // 5. Federation: detect remote recipients and route
    if (config.federationEnabled && body.recipients.length > 0) {
      // Look up sender's tezAddress
      const senderContact = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, userId))
        .limit(1);
      const senderAddress = senderContact[0]?.tezAddress || `${userId}@${config.relayHost}`;

      const { remote } = partitionRecipients(body.recipients, config.relayHost);

      if (remote.size > 0) {
        // Fire-and-forget: don't block the response on federation
        routeToFederation({
          tezId,
          tez: {
            id: tezId,
            threadId,
            parentTezId: null,
            surfaceText: body.surfaceText,
            type: body.type,
            urgency: body.urgency,
            actionRequested: body.actionRequested ?? null,
            visibility: body.visibility,
            createdAt: now,
          },
          senderAddress,
          remoteRecipients: remote,
        }).catch((err) => console.error("Federation routing error:", err));
      }
    }

    res.status(201).json({
      data: {
        id: tezId,
        threadId,
        type: body.type,
        surfaceText: body.surfaceText,
        createdAt: now,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: (err as Error).message } });
      return;
    }
    console.error("Share error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to share Tez" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/stream — Get feed for authenticated user
// ─────────────────────────────────────────────────────────────────────────────

tezRoutes.get("/stream", authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const teamId = req.query.teamId as string;

    if (!teamId) {
      res.status(400).json({ error: { code: "MISSING_TEAM", message: "teamId query param required" } });
      return;
    }

    await assertTeamMember(userId, teamId);

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const before = req.query.before as string | undefined;

    // Get tezits: team-visible OR where user is a recipient
    let query = db
      .select()
      .from(tez)
      .where(
        and(
          eq(tez.teamId, teamId),
          eq(tez.status, "active"),
          or(
            eq(tez.visibility, "team"),
            eq(tez.senderUserId, userId)
            // DM recipients checked separately below
          )
        )
      )
      .orderBy(desc(tez.createdAt))
      .limit(limit);

    if (before) {
      // Simple cursor pagination: created before this timestamp
      const { lt } = await import("drizzle-orm");
      query = db
        .select()
        .from(tez)
        .where(
          and(
            eq(tez.teamId, teamId),
            eq(tez.status, "active"),
            lt(tez.createdAt, before),
            or(eq(tez.visibility, "team"), eq(tez.senderUserId, userId))
          )
        )
        .orderBy(desc(tez.createdAt))
        .limit(limit);
    }

    const items = await query;

    res.json({
      data: items,
      meta: { count: items.length, hasMore: items.length === limit },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: (err as Error).message } });
      return;
    }
    console.error("Stream error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to fetch stream" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /tez/:id/reply — Reply to a Tez (threaded)
// ─────────────────────────────────────────────────────────────────────────────

const ReplySchema = z.object({
  surfaceText: z.string().min(1).max(10000),
  type: z.enum(["note", "decision", "handoff", "question", "update"]).default("note"),
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

tezRoutes.post("/:id/reply", authenticate, async (req, res) => {
  try {
    const parentId = req.params.id;
    const body = ReplySchema.parse(req.body);
    const userId = req.user!.userId;

    // Find the parent Tez
    const parent = await db
      .select()
      .from(tez)
      .where(eq(tez.id, parentId))
      .limit(1);

    if (parent.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Tez not found" } });
      return;
    }

    const parentTez = parent[0];

    // ACL: verify access (team membership, conversation membership, or sender)
    await assertTezAccess(userId, parentTez);

    const now = new Date().toISOString();
    const replyId = randomUUID();

    // Reply joins the parent's thread
    const threadId = parentTez.threadId || parentTez.id;

    await db.insert(tez).values({
      id: replyId,
      teamId: parentTez.teamId ?? null,
      threadId,
      parentTezId: parentId,
      surfaceText: body.surfaceText,
      type: body.type,
      urgency: "normal",
      actionRequested: null,
      senderUserId: userId,
      visibility: parentTez.visibility,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Context items for the reply
    for (const ctx of body.context) {
      await db.insert(tezContext).values({
        id: randomUUID(),
        tezId: replyId,
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

    await recordAudit({
      teamId: parentTez.teamId ?? undefined,
      actorUserId: userId,
      action: "tez.replied",
      targetType: "tez",
      targetId: replyId,
      metadata: { parentTezId: parentId, threadId },
    });

    res.status(201).json({
      data: {
        id: replyId,
        threadId,
        parentTezId: parentId,
        surfaceText: body.surfaceText,
        createdAt: now,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: (err as Error).message } });
      return;
    }
    console.error("Reply error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to reply" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/:id — Get full Tez with context + provenance
// ─────────────────────────────────────────────────────────────────────────────

tezRoutes.get("/:id", authenticate, async (req, res) => {
  try {
    const tezId = req.params.id;
    const userId = req.user!.userId;

    const rows = await db.select().from(tez).where(eq(tez.id, tezId)).limit(1);
    if (rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Tez not found" } });
      return;
    }

    const theTez = rows[0];

    // ACL: verify access (team membership, conversation membership, or sender)
    await assertTezAccess(userId, theTez);

    // Fetch all context layers
    const contextItems = await db
      .select()
      .from(tezContext)
      .where(eq(tezContext.tezId, tezId));

    // Fetch recipients
    const recipients = await db
      .select()
      .from(tezRecipients)
      .where(eq(tezRecipients.tezId, tezId));

    // Record the read
    await recordAudit({
      teamId: theTez.teamId ?? undefined,
      actorUserId: userId,
      action: "tez.read",
      targetType: "tez",
      targetId: tezId,
    });

    res.json({
      data: {
        ...theTez,
        context: contextItems,
        recipients,
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: (err as Error).message } });
      return;
    }
    console.error("Get tez error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get Tez" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /tez/:id/thread — Get full conversation thread
// ─────────────────────────────────────────────────────────────────────────────

tezRoutes.get("/:id/thread", authenticate, async (req, res) => {
  try {
    const tezId = req.params.id;
    const userId = req.user!.userId;

    // Find the root tez to get the threadId
    const root = await db.select().from(tez).where(eq(tez.id, tezId)).limit(1);
    if (root.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Tez not found" } });
      return;
    }

    const threadId = root[0].threadId || root[0].id;

    // ACL: verify access (team membership, conversation membership, or sender)
    await assertTezAccess(userId, root[0]);

    // Get all tezits in this thread, chronological
    const thread = await db
      .select()
      .from(tez)
      .where(and(eq(tez.threadId, threadId), eq(tez.status, "active")))
      .orderBy(tez.createdAt);

    res.json({
      data: {
        threadId,
        rootTezId: threadId,
        messages: thread,
        messageCount: thread.length,
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: (err as Error).message } });
      return;
    }
    console.error("Thread error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get thread" } });
  }
});
