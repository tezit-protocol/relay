/**
 * Federation routes — server-to-server Tez delivery.
 *
 * POST /federation/inbox       — Receive a Tez from a remote server
 * GET  /federation/server-info — Public server identity
 * POST /federation/verify      — Trust handshake (register remote server)
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import {
  db,
  tez,
  tezContext,
  tezRecipients,
  contacts,
  federatedServers,
  federatedTez,
} from "../db/index.js";
import { config } from "../config.js";
import { getIdentity } from "../services/identity.js";
import { verifyRequest, extractKeyId } from "../services/httpSignature.js";
import { validateBundle, type FederationBundle } from "../services/federationBundle.js";
import { recordAudit } from "../services/audit.js";
import { sendWelcomeCookie } from "../services/welcomeCookie.js";

export const federationRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /federation/inbox — Receive a Tez from a remote server
// ─────────────────────────────────────────────────────────────────────────────

federationRoutes.post("/inbox", async (req, res) => {
  try {
    if (!config.federationEnabled) {
      res.status(404).json({ error: { code: "FEDERATION_DISABLED", message: "Federation is not enabled" } });
      return;
    }

    // 1. Verify HTTP Signature
    const signature = req.headers["signature"] as string;
    const signatureInput = req.headers["signature-input"] as string;
    const digest = req.headers["digest"] as string;
    const date = req.headers["date"] as string;
    const host = req.headers["host"] as string;

    if (!signature || !signatureInput || !digest || !date) {
      res.status(401).json({ error: { code: "MISSING_SIGNATURE", message: "Missing HTTP signature headers" } });
      return;
    }

    // Extract sender server from signature keyId
    const keyId = extractKeyId(signatureInput);
    if (!keyId) {
      res.status(401).json({ error: { code: "INVALID_SIGNATURE", message: "Cannot extract keyId from signature" } });
      return;
    }

    // 2. Look up sender server
    const senderRows = await db
      .select()
      .from(federatedServers)
      .where(eq(federatedServers.serverId, keyId))
      .limit(1);

    if (senderRows.length === 0) {
      res.status(403).json({ error: { code: "UNKNOWN_SERVER", message: "Sending server is not registered" } });
      return;
    }

    const sender = senderRows[0];

    // Check trust level
    if (sender.trustLevel === "blocked") {
      res.status(403).json({ error: { code: "SERVER_BLOCKED", message: "Sending server is blocked" } });
      return;
    }

    if (config.federationMode === "allowlist" && sender.trustLevel !== "trusted") {
      res.status(403).json({ error: { code: "SERVER_NOT_TRUSTED", message: "Server not in trusted allowlist" } });
      return;
    }

    // 3. Verify signature
    const body = JSON.stringify(req.body);
    const isValid = verifyRequest({
      method: req.method,
      path: req.path,
      host: host || config.relayHost,
      date,
      digest,
      signature,
      signatureInput,
      body,
      publicKeyBase64: sender.publicKey,
    });

    if (!isValid) {
      res.status(401).json({ error: { code: "INVALID_SIGNATURE", message: "HTTP signature verification failed" } });
      return;
    }

    // 4. Validate bundle format
    const bundle = req.body as FederationBundle;
    const validationError = validateBundle(bundle);
    if (validationError) {
      res.status(422).json({ error: { code: "INVALID_BUNDLE", message: validationError } });
      return;
    }

    // 5. Deliver to local recipients
    const identity = getIdentity();
    const localRecipients = bundle.to.filter((addr) => {
      const atIndex = addr.lastIndexOf("@");
      return atIndex !== -1 && addr.slice(atIndex + 1) === identity.host;
    });

    if (localRecipients.length === 0) {
      res.status(422).json({ error: { code: "NO_LOCAL_RECIPIENTS", message: "No recipients on this server" } });
      return;
    }

    const now = new Date().toISOString();
    const localTezIds: string[] = [];
    const notFound: string[] = [];

    // Create local tez for each recipient
    const localTezId = randomUUID();
    const threadId = localTezId;

    await db.insert(tez).values({
      id: localTezId,
      teamId: null,
      conversationId: null,
      threadId,
      parentTezId: null,
      surfaceText: bundle.tez.surfaceText,
      type: bundle.tez.type || "note",
      urgency: bundle.tez.urgency || "normal",
      actionRequested: bundle.tez.actionRequested ?? null,
      senderUserId: bundle.from,
      visibility: "dm",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Create context layers
    for (const ctx of bundle.context) {
      await db.insert(tezContext).values({
        id: randomUUID(),
        tezId: localTezId,
        layer: ctx.layer,
        content: ctx.content,
        mimeType: ctx.mimeType ?? null,
        confidence: ctx.confidence ?? null,
        source: ctx.source ?? null,
        derivedFrom: null,
        createdAt: now,
        createdBy: bundle.from,
      });
    }

    // Record recipients
    for (const addr of localRecipients) {
      const atIndex = addr.lastIndexOf("@");
      const userId = addr.slice(0, atIndex);

      // Verify recipient exists
      const contactRows = await db
        .select()
        .from(contacts)
        .where(eq(contacts.tezAddress, addr))
        .limit(1);

      if (contactRows.length === 0) {
        notFound.push(addr);
        continue;
      }

      await db.insert(tezRecipients).values({
        tezId: localTezId,
        userId: contactRows[0].id,
        deliveredAt: now,
        readAt: null,
        acknowledgedAt: null,
      });
    }

    localTezIds.push(localTezId);

    // Record in federated_tez
    await db.insert(federatedTez).values({
      id: randomUUID(),
      localTezId,
      remoteTezId: bundle.tez.id,
      remoteHost: bundle.sender_server,
      direction: "inbound",
      bundleHash: bundle.bundle_hash,
      federatedAt: now,
    });

    // Update sender's lastSeenAt
    await db
      .update(federatedServers)
      .set({ lastSeenAt: now })
      .where(eq(federatedServers.host, sender.host));

    // Audit
    await recordAudit({
      actorUserId: bundle.from,
      action: "federation.received",
      targetType: "tez",
      targetId: localTezId,
      metadata: {
        remoteServer: bundle.sender_server,
        remoteTezId: bundle.tez.id,
        recipientCount: localRecipients.length,
        notFoundCount: notFound.length,
      },
    });

    // 207 if some recipients not found, 200 otherwise
    if (notFound.length > 0 && notFound.length < localRecipients.length) {
      res.status(207).json({
        accepted: true,
        localTezIds,
        notFound,
      });
    } else if (notFound.length === localRecipients.length) {
      res.status(422).json({
        error: { code: "RECIPIENTS_NOT_FOUND", message: "No valid recipients found" },
        notFound,
      });
    } else {
      res.json({ accepted: true, localTezIds });
    }
  } catch (err) {
    console.error("Federation inbox error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to process federation delivery" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /federation/server-info — Public server identity
// ─────────────────────────────────────────────────────────────────────────────

federationRoutes.get("/server-info", (_req, res) => {
  try {
    const identity = getIdentity();

    res.json({
      host: identity.host,
      server_id: identity.serverId,
      public_key: identity.publicKey,
      protocol_version: "1.2.4",
      profiles: ["messaging", "knowledge"],
      federation: {
        enabled: config.federationEnabled,
        mode: config.federationMode,
        inbox: "/federation/inbox",
      },
    });
  } catch (err) {
    console.error("Server info error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to get server info" } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /federation/verify — Trust handshake
// ─────────────────────────────────────────────────────────────────────────────

federationRoutes.post("/verify", async (req, res) => {
  try {
    if (!config.federationEnabled) {
      res.status(404).json({ error: { code: "FEDERATION_DISABLED", message: "Federation is not enabled" } });
      return;
    }

    const { host, server_id, public_key, display_name } = req.body;

    if (!host || !server_id || !public_key) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Missing required fields: host, server_id, public_key" },
      });
      return;
    }

    const now = new Date().toISOString();

    // Check if server already exists
    const existing = await db
      .select()
      .from(federatedServers)
      .where(eq(federatedServers.host, host))
      .limit(1);

    if (existing.length > 0) {
      // Update last seen
      await db
        .update(federatedServers)
        .set({
          lastSeenAt: now,
          publicKey: public_key,
          serverId: server_id,
          displayName: display_name ?? existing[0].displayName,
        })
        .where(eq(federatedServers.host, host));

      res.json({ status: existing[0].trustLevel });
      return;
    }

    // Create new server record
    const trustLevel = config.federationMode === "open" ? "trusted" : "pending";

    await db.insert(federatedServers).values({
      host,
      serverId: server_id,
      publicKey: public_key,
      displayName: display_name ?? null,
      trustLevel,
      protocolVersion: "1.2.4",
      lastSeenAt: now,
      firstSeenAt: now,
      metadata: null,
    });

    // Send welcome cookie to newly trusted peers (non-blocking)
    if (trustLevel === "trusted") {
      sendWelcomeCookie(host).catch(() => {});
    }

    res.json({ status: trustLevel });
  } catch (err) {
    console.error("Federation verify error:", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to process trust handshake" } });
  }
});
