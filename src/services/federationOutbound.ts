/**
 * Outbound federation — route and deliver Tez to remote servers.
 *
 * When a Tez is shared and recipients include remote addresses,
 * this service groups by host, creates bundles, signs requests,
 * and manages the delivery queue with retry logic.
 */

import { randomUUID } from "crypto";
import { eq, and, lte } from "drizzle-orm";
import {
  db,
  tezContext as tezContextTable,
  federationOutbox,
  federatedTez,
  federatedServers,
} from "../db/index.js";
import { config } from "../config.js";
import { getIdentity, type ServerIdentity } from "./identity.js";
import { signRequest } from "./httpSignature.js";
import { createBundle } from "./federationBundle.js";
import { discoverServer } from "./discovery.js";
import { recordAudit } from "./audit.js";

// Retry schedule: 1min, 5min, 30min, 2h, 12h
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * Determine which recipients are remote (different host than ours).
 */
export function partitionRecipients(
  recipients: string[],
  localHost: string
): { local: string[]; remote: Map<string, string[]> } {
  const local: string[] = [];
  const remote = new Map<string, string[]>();

  for (const addr of recipients) {
    const atIndex = addr.lastIndexOf("@");
    if (atIndex === -1) {
      local.push(addr); // Not a tezAddress, treat as local userId
      continue;
    }
    const host = addr.slice(atIndex + 1);
    if (host === localHost) {
      local.push(addr);
    } else {
      const existing = remote.get(host) || [];
      existing.push(addr);
      remote.set(host, existing);
    }
  }

  return { local, remote };
}

/**
 * Route a Tez to remote servers for federation delivery.
 * Called after a local share when remote recipients are detected.
 */
export async function routeToFederation(params: {
  tezId: string;
  tez: {
    id: string;
    threadId: string | null;
    parentTezId: string | null;
    surfaceText: string;
    type: string;
    urgency: string;
    actionRequested: string | null;
    visibility: string;
    createdAt: string;
  };
  senderAddress: string;
  remoteRecipients: Map<string, string[]>; // host → addresses
}): Promise<void> {
  if (!config.federationEnabled) return;

  const identity = getIdentity();

  // Fetch context for this tez
  const contextRows = await db
    .select()
    .from(tezContextTable)
    .where(eq(tezContextTable.tezId, params.tezId));

  const context = contextRows.map((c) => ({
    layer: c.layer,
    content: c.content,
    mimeType: c.mimeType,
    confidence: c.confidence,
    source: c.source,
  }));

  const now = new Date().toISOString();

  for (const [targetHost, addresses] of params.remoteRecipients) {
    const bundle = createBundle({
      tez: params.tez,
      context,
      from: params.senderAddress,
      to: addresses,
      identity,
    });

    // Insert into outbox
    const outboxId = randomUUID();
    await db.insert(federationOutbox).values({
      id: outboxId,
      tezId: params.tezId,
      targetHost,
      targetAddresses: addresses,
      bundle: bundle as unknown as Record<string, unknown>,
      status: "pending",
      attempts: 0,
      lastAttemptAt: null,
      nextRetryAt: now,
      createdAt: now,
      deliveredAt: null,
      error: null,
    });

    // Attempt immediate delivery
    await processOutboxEntry(outboxId);
  }
}

/**
 * Process a single outbox entry: attempt delivery to the remote server.
 */
async function processOutboxEntry(outboxId: string): Promise<void> {
  const rows = await db
    .select()
    .from(federationOutbox)
    .where(eq(federationOutbox.id, outboxId))
    .limit(1);

  if (rows.length === 0) return;

  const entry = rows[0];
  if (entry.status === "delivered" || entry.status === "expired") return;

  const identity = getIdentity();
  const now = new Date().toISOString();

  try {
    // Discover remote server
    const remote = await discoverServer(entry.targetHost);

    // Sign the request (Drizzle deserializes JSON columns, so re-serialize for HTTP)
    const bundleBody = JSON.stringify(entry.bundle);
    const inboxUrl = `https://${entry.targetHost}${remote.federationInbox}`;
    const inboxPath = remote.federationInbox;

    const signedHeaders = signRequest({
      method: "POST",
      path: inboxPath,
      host: entry.targetHost,
      body: bundleBody,
      privateKeyPem: identity.privateKeyPem,
      keyId: identity.serverId,
    });

    // Send to remote inbox
    const response = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signedHeaders,
      },
      body: bundleBody,
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok || response.status === 207) {
      // Success
      await db
        .update(federationOutbox)
        .set({
          status: "delivered",
          deliveredAt: now,
          lastAttemptAt: now,
          attempts: entry.attempts + 1,
        })
        .where(eq(federationOutbox.id, outboxId));

      // Record federated_tez (entry.bundle already deserialized by Drizzle)
      const bundle = entry.bundle as Record<string, any>;
      await db.insert(federatedTez).values({
        id: randomUUID(),
        localTezId: entry.tezId,
        remoteTezId: bundle.tez.id,
        remoteHost: entry.targetHost,
        direction: "outbound",
        bundleHash: bundle.bundle_hash,
        federatedAt: now,
      });

      await recordAudit({
        actorUserId: bundle.from || "system",
        action: "federation.sent",
        targetType: "tez",
        targetId: entry.tezId,
        metadata: {
          remoteHost: entry.targetHost,
          recipientCount: entry.targetAddresses.length,
        },
      });
    } else {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
  } catch (err) {
    const attempts = entry.attempts + 1;
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (attempts >= MAX_ATTEMPTS) {
      // Exhausted retries
      await db
        .update(federationOutbox)
        .set({
          status: "expired",
          attempts,
          lastAttemptAt: now,
          error: errorMsg,
        })
        .where(eq(federationOutbox.id, outboxId));

      await recordAudit({
        actorUserId: "system",
        action: "federation.failed",
        targetType: "tez",
        targetId: entry.tezId,
        metadata: {
          remoteHost: entry.targetHost,
          attempts,
          lastError: errorMsg,
        },
      });
    } else {
      // Schedule retry
      const delayMs = RETRY_DELAYS_MS[attempts - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      const nextRetry = new Date(Date.now() + delayMs).toISOString();

      await db
        .update(federationOutbox)
        .set({
          status: "failed",
          attempts,
          lastAttemptAt: now,
          nextRetryAt: nextRetry,
          error: errorMsg,
        })
        .where(eq(federationOutbox.id, outboxId));
    }
  }
}

/**
 * Process all pending/failed outbox entries that are due for retry.
 * Can be called periodically by a worker or cron.
 */
export async function processOutboxQueue(): Promise<number> {
  const now = new Date().toISOString();

  const pending = await db
    .select()
    .from(federationOutbox)
    .where(
      and(
        lte(federationOutbox.nextRetryAt, now),
        eq(federationOutbox.status, "failed")
      )
    )
    .limit(50);

  // Also get fresh pending entries
  const fresh = await db
    .select()
    .from(federationOutbox)
    .where(eq(federationOutbox.status, "pending"))
    .limit(50);

  const all = [...pending, ...fresh];

  for (const entry of all) {
    await processOutboxEntry(entry.id);
  }

  return all.length;
}
