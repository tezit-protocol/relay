/**
 * Team routes — minimal team management.
 *
 * POST /teams              — Create team
 * GET  /teams/:id/members  — List members
 * POST /teams/:id/members  — Add member
 * DELETE /teams/:id/members/:userId — Remove member
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, teams, teamMembers } from "../db/index.js";
import { authenticate } from "../middleware/auth.js";
import { assertTeamMember, isTeamAdmin } from "../services/acl.js";
import { recordAudit } from "../services/audit.js";

export const teamRoutes = Router();

// GET /teams — List teams I belong to
teamRoutes.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const rows = await db
      .select({ id: teams.id, name: teams.name, role: teamMembers.role })
      .from(teams)
      .innerJoin(teamMembers, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.userId, userId));

    res.json({ data: rows });
  } catch (err) {
    console.error("List teams error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to list teams" } });
  }
});

// POST /teams — Create a team
const CreateTeamSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
});

teamRoutes.post("/", authenticate, async (req, res) => {
  try {
    const body = CreateTeamSchema.parse(req.body);
    const userId = req.user!.userId;
    const now = new Date().toISOString();
    const teamId = body.id || randomUUID();

    await db.insert(teams).values({
      id: teamId,
      name: body.name,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    // Creator is admin
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: "admin",
      joinedAt: now,
    });

    await recordAudit({
      teamId,
      actorUserId: userId,
      action: "team.created",
      targetType: "team",
      targetId: teamId,
      metadata: { name: body.name },
    });

    res.status(201).json({ data: { id: teamId, name: body.name } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    console.error("Create team error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to create team" } });
  }
});

// GET /teams/:id/members
teamRoutes.get("/:id/members", authenticate, async (req, res) => {
  try {
    const teamId = req.params.id;
    await assertTeamMember(req.user!.userId, teamId);

    const members = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));

    res.json({ data: members });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: (err as Error).message } });
      return;
    }
    console.error("List members error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to list members" } });
  }
});

// POST /teams/:id/members — Add member (admin only)
const AddMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "member"]).default("member"),
});

teamRoutes.post("/:id/members", authenticate, async (req, res) => {
  try {
    const teamId = req.params.id;
    const body = AddMemberSchema.parse(req.body);
    const actorId = req.user!.userId;

    if (!(await isTeamAdmin(actorId, teamId))) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins can add members" } });
      return;
    }

    const now = new Date().toISOString();
    await db.insert(teamMembers).values({
      teamId,
      userId: body.userId,
      role: body.role,
      joinedAt: now,
    });

    await recordAudit({
      teamId,
      actorUserId: actorId,
      action: "team.member_added",
      targetType: "team",
      targetId: teamId,
      metadata: { addedUserId: body.userId, role: body.role },
    });

    res.status(201).json({ data: { teamId, userId: body.userId, role: body.role } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return;
    }
    console.error("Add member error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to add member" } });
  }
});

// DELETE /teams/:id/members/:userId — Remove member (admin only, or self-leave)
teamRoutes.delete("/:id/members/:userId", authenticate, async (req, res) => {
  try {
    const teamId = req.params.id;
    const targetUserId = req.params.userId;
    const actorId = req.user!.userId;

    const isSelfLeave = actorId === targetUserId;
    if (!isSelfLeave && !(await isTeamAdmin(actorId, teamId))) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins can remove members" } });
      return;
    }

    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)));

    await recordAudit({
      teamId,
      actorUserId: actorId,
      action: "team.member_removed",
      targetType: "team",
      targetId: teamId,
      metadata: { removedUserId: targetUserId, selfLeave: isSelfLeave },
    });

    res.json({ data: { removed: true } });
  } catch (err) {
    console.error("Remove member error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to remove member" } });
  }
});
