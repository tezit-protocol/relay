/**
 * Admin routes — federation trust management.
 *
 * All admin routes require JWT + admin role (configured via ADMIN_USER_IDS).
 *
 * GET    /admin/federation/servers       — List known servers
 * PATCH  /admin/federation/servers/:host — Update trust level
 * DELETE /admin/federation/servers/:host — Remove server
 * GET    /admin/federation/outbox        — View delivery queue
 */

import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db, federatedServers, federationOutbox } from "../db/index.js";
import { authenticate } from "../middleware/auth.js";
import { config } from "../config.js";
import { sendWelcomeCookie } from "../services/welcomeCookie.js";

export const adminRoutes = Router();

/**
 * Middleware: verify JWT user is in ADMIN_USER_IDS list.
 */
function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const userId = req.user?.userId;
  if (!userId || !config.adminUserIds.includes(userId)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin access required" } });
    return;
  }
  next();
}

// All admin routes require auth + admin
adminRoutes.use(authenticate, requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/federation/servers — List known servers
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get("/federation/servers", async (_req, res) => {
  try {
    const servers = await db.select().from(federatedServers);
    res.json({ data: servers });
  } catch (err) {
    console.error("List servers error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to list servers" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/federation/servers/:host — Update trust level
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.patch("/federation/servers/:host", async (req, res) => {
  try {
    const host = req.params.host;
    const { trust_level } = req.body;

    if (!trust_level || !["pending", "trusted", "blocked"].includes(trust_level)) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "trust_level must be one of: pending, trusted, blocked" },
      });
      return;
    }

    const existing = await db
      .select()
      .from(federatedServers)
      .where(eq(federatedServers.host, host))
      .limit(1);

    if (existing.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
      return;
    }

    const previousTrust = existing[0].trustLevel;

    await db
      .update(federatedServers)
      .set({ trustLevel: trust_level })
      .where(eq(federatedServers.host, host));

    // Send welcome cookie when a server is promoted to trusted (non-blocking)
    if (trust_level === "trusted" && previousTrust !== "trusted") {
      sendWelcomeCookie(host).catch(() => {});
    }

    res.json({ data: { host, trust_level } });
  } catch (err) {
    console.error("Update server error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to update server" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/federation/servers/:host — Remove server
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.delete("/federation/servers/:host", async (req, res) => {
  try {
    const host = req.params.host;

    const existing = await db
      .select()
      .from(federatedServers)
      .where(eq(federatedServers.host, host))
      .limit(1);

    if (existing.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Server not found" } });
      return;
    }

    await db.delete(federatedServers).where(eq(federatedServers.host, host));

    res.json({ data: { removed: true } });
  } catch (err) {
    console.error("Delete server error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to delete server" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/federation/outbox — View delivery queue
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get("/federation/outbox", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query;
    if (status) {
      query = db
        .select()
        .from(federationOutbox)
        .where(eq(federationOutbox.status, status))
        .orderBy(desc(federationOutbox.createdAt))
        .limit(limit);
    } else {
      query = db
        .select()
        .from(federationOutbox)
        .orderBy(desc(federationOutbox.createdAt))
        .limit(limit);
    }

    const entries = await query;

    res.json({
      data: entries,
      meta: { count: entries.length },
    });
  } catch (err) {
    console.error("Outbox list error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to list outbox" } });
  }
});
