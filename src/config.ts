/**
 * tezit-relay configuration
 *
 * All settings from environment. No hardcoded product names.
 * dotenv must load here (not in index.ts) because ESM import hoisting
 * evaluates this module before any code in index.ts runs.
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig();

// Issue #1: Reject insecure JWT secret in production
const jwtSecret = process.env.JWT_SECRET || "change-me-in-production";
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me-in-production")
) {
  throw new Error(
    "FATAL: JWT_SECRET must be set to a secure value in production. " +
    "Do not use the default 'change-me-in-production'."
  );
}

export const config = {
  port: parseInt(process.env.PORT || "3002", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  // Auth — pluggable JWT verification
  jwtSecret,
  jwtIssuer: process.env.JWT_ISSUER || "tezit-relay",

  // Relay identity
  relayHost: process.env.RELAY_HOST || "localhost",

  // Limits
  maxTezSizeBytes: parseInt(process.env.MAX_TEZ_SIZE_BYTES || "1048576", 10),
  maxContextItems: parseInt(process.env.MAX_CONTEXT_ITEMS || "50", 10),
  maxRecipients: parseInt(process.env.MAX_RECIPIENTS || "100", 10),

  // Federation
  federationEnabled: process.env.FEDERATION_ENABLED === "true",
  federationMode: (process.env.FEDERATION_MODE || "allowlist") as "allowlist" | "open",
  dataDir: process.env.DATA_DIR || "./data",
  adminUserIds: (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean),
} as const;
