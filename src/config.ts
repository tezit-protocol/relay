/**
 * tezit-relay configuration
 *
 * All settings from environment. No hardcoded product names.
 * dotenv must load here (not in index.ts) because ESM import hoisting
 * evaluates this module before any code in index.ts runs.
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig();

export const config = {
  port: parseInt(process.env.PORT || "3002", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  // Auth — pluggable JWT verification
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
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
