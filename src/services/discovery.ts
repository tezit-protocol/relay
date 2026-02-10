/**
 * Server discovery — fetch and cache remote server capabilities.
 *
 * Queries https://{host}/.well-known/tezit.json to learn about remote servers.
 * Caches in-memory with 1-hour TTL. Falls back to DB cache on network failure.
 */

import { eq } from "drizzle-orm";
import { db, federatedServers } from "../db/index.js";

export interface RemoteServerInfo {
  host: string;
  serverId: string;
  publicKey: string;
  federationInbox: string;
  protocolVersion: string;
  profiles: string[];
  cachedAt: Date;
}

// In-memory cache: host → info + expiry
const cache = new Map<string, { info: RemoteServerInfo; expiresAt: number }>();

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch .well-known/tezit.json from a remote host.
 * Validates required fields.
 */
async function fetchWellKnown(host: string): Promise<RemoteServerInfo> {
  const url = `https://${host}/.well-known/tezit.json`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Discovery failed for ${host}: HTTP ${res.status}`);
  }

  const data = await res.json();

  // Validate required fields
  if (!data.server_id || !data.public_key || !data.federation?.inbox) {
    throw new Error(`Discovery failed for ${host}: missing required fields (server_id, public_key, federation.inbox)`);
  }

  return {
    host,
    serverId: data.server_id,
    publicKey: data.public_key,
    federationInbox: data.federation.inbox,
    protocolVersion: data.protocol_version || "1.0.0",
    profiles: data.profiles || [],
    cachedAt: new Date(),
  };
}

/**
 * Try to load server info from the federated_servers DB table.
 */
async function loadFromDb(host: string): Promise<RemoteServerInfo | null> {
  try {
    const rows = await db
      .select()
      .from(federatedServers)
      .where(eq(federatedServers.host, host))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0];
    const metadata = row.metadata ? JSON.parse(row.metadata as string) : {};

    return {
      host: row.host,
      serverId: row.serverId,
      publicKey: row.publicKey,
      federationInbox: metadata.federationInbox || `/federation/inbox`,
      protocolVersion: row.protocolVersion || "1.0.0",
      profiles: metadata.profiles || [],
      cachedAt: new Date(row.lastSeenAt || row.firstSeenAt),
    };
  } catch {
    return null;
  }
}

/**
 * Discover a remote server's capabilities.
 * Checks in-memory cache first, then network, falls back to DB cache.
 */
export async function discoverServer(host: string): Promise<RemoteServerInfo> {
  // Check in-memory cache
  const cached = cache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.info;
  }

  // Try network
  try {
    const info = await fetchWellKnown(host);
    cache.set(host, { info, expiresAt: Date.now() + CACHE_TTL_MS });
    return info;
  } catch (networkErr) {
    // Fallback to DB cache
    const dbInfo = await loadFromDb(host);
    if (dbInfo) {
      cache.set(host, { info: dbInfo, expiresAt: Date.now() + CACHE_TTL_MS });
      return dbInfo;
    }
    throw networkErr;
  }
}

/**
 * Inject a server into the discovery cache (for testing).
 */
export function injectCache(host: string, info: RemoteServerInfo): void {
  cache.set(host, { info, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Clear the discovery cache (for testing).
 */
export function clearCache(): void {
  cache.clear();
}
