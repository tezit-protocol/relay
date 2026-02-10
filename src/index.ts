/**
 * tezit-relay
 *
 * Open relay server for the Tezit Protocol.
 * Does one thing: securely deliver and persist context-rich messages (Tez) for teams.
 */

import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { tezRoutes } from "./routes/tez.js";
import { teamRoutes } from "./routes/teams.js";
import { contactRoutes } from "./routes/contacts.js";
import { conversationRoutes } from "./routes/conversations.js";
import { unreadRoutes } from "./routes/unread.js";
import { federationRoutes } from "./routes/federation.js";
import { adminRoutes } from "./routes/admin.js";
import { initIdentity, getIdentity } from "./services/identity.js";
import { rateLimit } from "./middleware/rateLimit.js";

const app = express();
app.disable("x-powered-by");

// Issue #3: Configure CORS with explicit origins in production
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : undefined; // undefined = allow all (dev default)

app.use(
  cors({
    origin: config.nodeEnv === "production" && corsOrigins ? corsOrigins : true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: "1mb" }));

// Issue #4: Global rate limiting — 100 req/min per IP
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// Issue #17: Health — omit version in production
app.get("/health", (_req, res) => {
  const response: Record<string, string> = { status: "ok", service: "tezit-relay" };
  if (config.nodeEnv !== "production") {
    response.version = "0.3.0";
  }
  res.json(response);
});

// .well-known/tezit.json — server discovery for federation
app.get("/.well-known/tezit.json", (_req, res) => {
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
  } catch {
    // Identity not initialized (federation disabled)
    res.json({
      host: config.relayHost,
      protocol_version: "1.2.4",
      profiles: ["messaging", "knowledge"],
      federation: { enabled: false },
    });
  }
});

// Core routes
app.use("/tez", tezRoutes);
app.use("/teams", teamRoutes);
app.use("/contacts", contactRoutes);
app.use("/conversations", conversationRoutes);
app.use("/unread", unreadRoutes);

// Federation routes
app.use("/federation", federationRoutes);
app.use("/admin", adminRoutes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route not found` },
  });
});

// Initialize server identity if federation is enabled
if (config.federationEnabled) {
  try {
    const identity = initIdentity();
    console.log(`Federation enabled: serverId=${identity.serverId}, host=${identity.host}`);
  } catch (err) {
    console.error("Failed to initialize server identity:", err);
  }
}

app.listen(config.port, () => {
  console.log(`tezit-relay listening on port ${config.port}`);
});

export default app;
