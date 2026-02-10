/**
 * Server identity — Ed25519 keypair management for federation.
 *
 * Each relay generates a keypair on first boot, persisted to DATA_DIR.
 * The public key is exposed via .well-known/tezit.json.
 * The serverId is the first 16 hex chars of the SHA-256 hash of the public key.
 */

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";

export interface ServerIdentity {
  serverId: string;
  publicKey: string;       // Base64-encoded Ed25519 public key (DER)
  privateKeyPem: string;   // PEM-encoded private key (for signing)
  host: string;
}

let _identity: ServerIdentity | null = null;

/**
 * Derive serverId from public key: SHA-256 hash, hex, first 16 chars.
 */
function deriveServerId(publicKeyBase64: string): string {
  return createHash("sha256").update(publicKeyBase64).digest("hex").slice(0, 16);
}

/**
 * Generate a new Ed25519 keypair and persist to disk.
 */
function generateAndPersist(dataDir: string): { publicKeyBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64 = publicKeyDer.toString("base64");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "server.pub"), publicKeyBase64, "utf-8");
  writeFileSync(join(dataDir, "server.key"), privateKeyPem, "utf-8");

  return { publicKeyBase64, privateKeyPem };
}

/**
 * Load existing keypair from disk, or generate if missing.
 */
function loadOrGenerate(dataDir: string): { publicKeyBase64: string; privateKeyPem: string } {
  const pubPath = join(dataDir, "server.pub");
  const keyPath = join(dataDir, "server.key");

  if (existsSync(pubPath) && existsSync(keyPath)) {
    return {
      publicKeyBase64: readFileSync(pubPath, "utf-8").trim(),
      privateKeyPem: readFileSync(keyPath, "utf-8"),
    };
  }

  return generateAndPersist(dataDir);
}

/**
 * Initialize server identity. Call once at startup.
 * Returns the identity for use in federation.
 */
export function initIdentity(dataDir?: string): ServerIdentity {
  const dir = dataDir ?? config.dataDir;
  const { publicKeyBase64, privateKeyPem } = loadOrGenerate(dir);
  const serverId = deriveServerId(publicKeyBase64);

  _identity = {
    serverId,
    publicKey: publicKeyBase64,
    privateKeyPem,
    host: config.relayHost,
  };

  return _identity;
}

/**
 * Initialize identity from raw values (for testing without filesystem).
 */
export function initIdentityFromValues(values: {
  publicKey: string;
  privateKeyPem: string;
  host: string;
}): ServerIdentity {
  const serverId = deriveServerId(values.publicKey);
  _identity = {
    serverId,
    publicKey: values.publicKey,
    privateKeyPem: values.privateKeyPem,
    host: values.host,
  };
  return _identity;
}

/**
 * Get current server identity. Throws if not initialized.
 */
export function getIdentity(): ServerIdentity {
  if (!_identity) {
    throw new Error("Server identity not initialized. Call initIdentity() first.");
  }
  return _identity;
}

/**
 * Generate a fresh Ed25519 keypair in memory (for testing).
 */
export function generateKeyPair(): { publicKeyBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    publicKeyBase64: publicKeyDer.toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/**
 * Reset identity (for testing).
 */
export function resetIdentity(): void {
  _identity = null;
}
