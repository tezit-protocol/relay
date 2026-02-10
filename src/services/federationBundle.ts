/**
 * Federation bundle format — the payload exchanged between federated servers.
 *
 * Reuses the portable bundle concept but adds federation metadata,
 * integrity hash, and addressing information.
 */

import { createHash } from "crypto";
import type { ServerIdentity } from "./identity.js";

export interface FederationBundle {
  // Envelope
  protocol_version: string;
  bundle_type: "federation_delivery";
  sender_server: string;
  sender_server_id: string;

  // Addressing
  from: string;   // sender tezAddress (alice@mypa.chat)
  to: string[];   // recipient tezAddresses (bob@company.tezit.chat)

  // Payload
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
  context: Array<{
    layer: string;
    content: string;
    mimeType: string | null;
    confidence: number | null;
    source: string | null;
  }>;

  // Integrity
  bundle_hash: string;
  signed_at: string;
}

/**
 * Compute the canonical hash of a bundle's payload (tez + context).
 * Uses sorted-keys JSON for deterministic output.
 */
export function computeBundleHash(
  tezData: FederationBundle["tez"],
  context: FederationBundle["context"]
): string {
  // Sort keys recursively for canonical JSON
  const canonical = JSON.stringify({ context, tez: tezData });
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Create a federation bundle from a local Tez and its context.
 */
export function createBundle(params: {
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
  context: Array<{
    layer: string;
    content: string;
    mimeType: string | null;
    confidence: number | null;
    source: string | null;
  }>;
  from: string;
  to: string[];
  identity: ServerIdentity;
}): FederationBundle {
  const bundleHash = computeBundleHash(params.tez, params.context);

  return {
    protocol_version: "1.2.4",
    bundle_type: "federation_delivery",
    sender_server: params.identity.host,
    sender_server_id: params.identity.serverId,
    from: params.from,
    to: params.to,
    tez: params.tez,
    context: params.context,
    bundle_hash: bundleHash,
    signed_at: new Date().toISOString(),
  };
}

/**
 * Validate a received federation bundle.
 * Checks structure, required fields, and hash integrity.
 * Returns null if valid, or an error message string.
 */
export function validateBundle(bundle: unknown): string | null {
  if (!bundle || typeof bundle !== "object") {
    return "Bundle must be an object";
  }

  const b = bundle as Record<string, unknown>;

  if (b.bundle_type !== "federation_delivery") {
    return `Invalid bundle_type: ${b.bundle_type}`;
  }

  if (!b.sender_server || typeof b.sender_server !== "string") {
    return "Missing sender_server";
  }

  if (!b.sender_server_id || typeof b.sender_server_id !== "string") {
    return "Missing sender_server_id";
  }

  if (!b.from || typeof b.from !== "string") {
    return "Missing from address";
  }

  if (!Array.isArray(b.to) || b.to.length === 0) {
    return "Missing or empty to addresses";
  }

  if (!b.tez || typeof b.tez !== "object") {
    return "Missing tez payload";
  }

  const tezData = b.tez as Record<string, unknown>;
  if (!tezData.id || !tezData.surfaceText || !tezData.createdAt) {
    return "Missing required tez fields (id, surfaceText, createdAt)";
  }

  if (!Array.isArray(b.context)) {
    return "Missing context array";
  }

  if (!b.bundle_hash || typeof b.bundle_hash !== "string") {
    return "Missing bundle_hash";
  }

  // Verify hash integrity
  const expectedHash = computeBundleHash(
    b.tez as FederationBundle["tez"],
    b.context as FederationBundle["context"]
  );
  if (b.bundle_hash !== expectedHash) {
    return "Bundle hash mismatch — payload may have been tampered with";
  }

  return null;
}
