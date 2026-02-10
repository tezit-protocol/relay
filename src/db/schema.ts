/**
 * tezit-relay database schema
 *
 * Core tables for persisting and delivering context-rich messages (Tez).
 * Deliberately minimal — no billing, no onboarding, no AI runtime tables.
 */

import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

// ─────────────────────────────────────────────────────────────────────────────
// TEAMS — who can communicate
// ─────────────────────────────────────────────────────────────────────────────

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(), // UUID
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(), // userId of creator
  createdAt: text("created_at").notNull(), // ISO8601
  updatedAt: text("updated_at").notNull(),
});

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // "admin" | "member"
    joinedAt: text("joined_at").notNull(),
  },
  (table) => [
    index("idx_tm_team").on(table.teamId),
    index("idx_tm_user").on(table.userId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// TEZ — the message (surface layer)
// ─────────────────────────────────────────────────────────────────────────────

export const tez = sqliteTable(
  "tez",
  {
    id: text("id").primaryKey(), // UUID
    teamId: text("team_id").references(() => teams.id), // optional — tez belongs to team OR conversation
    conversationId: text("conversation_id"), // FK → conversations.id (optional)
    threadId: text("thread_id"), // null = root of new thread, else references tez.id
    parentTezId: text("parent_tez_id"), // direct reply-to (for threading)

    // Surface — what the recipient sees first
    surfaceText: text("surface_text").notNull(),
    type: text("type").notNull().default("note"), // note | decision | handoff | question | update
    urgency: text("urgency").notNull().default("normal"), // critical | high | normal | low | fyi
    actionRequested: text("action_requested"), // what you want them to do

    // Origin
    senderUserId: text("sender_user_id").notNull(),
    visibility: text("visibility").notNull().default("private"), // private | dm | team

    // Channel bridge — set when message originated from an external channel
    sourceChannel: text("source_channel"), // "tezit" | "whatsapp" | "telegram" | "email" | "sms" | etc.
    sourceAddress: text("source_address"), // external sender address (phone, email, etc.)

    // State
    status: text("status").notNull().default("active"), // active | archived | deleted
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_tez_team").on(table.teamId),
    index("idx_tez_conversation").on(table.conversationId),
    index("idx_tez_thread").on(table.threadId),
    index("idx_tez_sender").on(table.senderUserId),
    index("idx_tez_created").on(table.createdAt),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// TEZ CONTEXT — the iceberg beneath the surface
// ─────────────────────────────────────────────────────────────────────────────

export const tezContext = sqliteTable(
  "tez_context",
  {
    id: text("id").primaryKey(), // UUID
    tezId: text("tez_id")
      .notNull()
      .references(() => tez.id),

    // What kind of context is this?
    layer: text("layer").notNull(),
    // "background"    — why this matters, how we got here
    // "fact"          — structured claim with confidence
    // "artifact"      — original evidence (voice, doc, etc.)
    // "relationship"  — connection to entity
    // "constraint"    — boundary or limitation
    // "hint"          — proactive suggestion for recipient

    content: text("content").notNull(), // the actual content (text or JSON)
    mimeType: text("mime_type"), // for binary artifacts
    confidence: integer("confidence"), // 0-100 for facts
    source: text("source"), // "stated" | "inferred" | "verified"
    derivedFrom: text("derived_from"), // id of context this was derived from

    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(), // userId or "system"
  },
  (table) => [index("idx_ctx_tez").on(table.tezId)]
);

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENTS — who should receive each Tez
// ─────────────────────────────────────────────────────────────────────────────

export const tezRecipients = sqliteTable(
  "tez_recipients",
  {
    tezId: text("tez_id")
      .notNull()
      .references(() => tez.id),
    userId: text("user_id").notNull(),
    deliveredAt: text("delivered_at"),
    readAt: text("read_at"),
    acknowledgedAt: text("acknowledged_at"),
  },
  (table) => [
    index("idx_recip_tez").on(table.tezId),
    index("idx_recip_user").on(table.userId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG — append-only, every mutation recorded
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS — user profiles / discovery
// ─────────────────────────────────────────────────────────────────────────────

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(), // same as userId
    displayName: text("display_name").notNull(),
    email: text("email"), // optional, for discovery
    avatarUrl: text("avatar_url"), // optional
    tezAddress: text("tez_address").notNull().unique(), // e.g. "user@relay.example.com"
    status: text("status").notNull().default("active"), // active | away | offline

    // Channel routing — PA picks the right delivery pipe per recipient
    // Ordered JSON array, e.g. ["tezit", "email", "whatsapp"]
    // First reachable channel wins. Empty/null = tezit-only.
    channels: text("channels", { mode: "json" }).$type<string[]>().default([]),
    preferredChannel: text("preferred_channel"), // explicit override, e.g. "whatsapp"
    phone: text("phone"), // for SMS/WhatsApp/Telegram delivery
    telegramId: text("telegram_id"), // for Telegram delivery

    lastSeenAt: text("last_seen_at"),
    registeredAt: text("registered_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_contacts_email").on(table.email),
    index("idx_contacts_tez_address").on(table.tezAddress),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONS — DM + group chat metadata
// ─────────────────────────────────────────────────────────────────────────────

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(), // UUID
  type: text("type").notNull(), // "dm" | "group"
  name: text("name"), // null for DMs, required for groups
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversationMembers = sqliteTable(
  "conversation_members",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    userId: text("user_id").notNull(),
    joinedAt: text("joined_at").notNull(),
    lastReadAt: text("last_read_at"), // cursor for unread counts
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index("idx_cm_conv").on(table.conversationId),
    index("idx_cm_user").on(table.userId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG — append-only, every mutation recorded
// ─────────────────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(), // UUID
    teamId: text("team_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    // "tez.shared" | "tez.replied" | "tez.read" | "tez.acknowledged"
    // "tez.archived" | "tez.deleted"
    // "team.created" | "team.member_added" | "team.member_removed"
    // "federation.sent" | "federation.received" | "federation.failed"
    targetType: text("target_type").notNull(), // "tez" | "team" | "contact" | "conversation" | "federation"
    targetId: text("target_id").notNull(),
    metadata: text("metadata", { mode: "json" }), // extra context (JSON)
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_audit_team").on(table.teamId),
    index("idx_audit_actor").on(table.actorUserId),
    index("idx_audit_target").on(table.targetType, table.targetId),
    index("idx_audit_time").on(table.createdAt),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL PROVIDER CONFIG — team-level provider credentials (admin-managed)
// ─────────────────────────────────────────────────────────────────────────────

export const channelProviderConfig = sqliteTable(
  "channel_provider_config",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    provider: text("provider").notNull(), // "telegram" | "whatsapp" | "slack" | "imessage" | "sms" | "email"
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    configRef: text("config_ref"), // secret reference — never raw credentials
    webhookSecretRef: text("webhook_secret_ref"), // secret reference
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.provider] }),
    index("idx_cpc_team").on(table.teamId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// USER CHANNEL LINK — per-user channel connection state + ownership
// ─────────────────────────────────────────────────────────────────────────────

export const userChannelLink = sqliteTable(
  "user_channel_link",
  {
    id: text("id").primaryKey(), // UUID
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(), // "telegram" | "whatsapp" | "slack" | etc.
    status: text("status").notNull().default("pending"), // pending | connected | failed | disconnected
    externalUserId: text("external_user_id"), // provider user id
    externalChatId: text("external_chat_id"), // provider conversation id
    handle: text("handle"), // username / phone / display name
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(), // provider-specific non-secret data
    lastVerifiedAt: text("last_verified_at"),
    failureReason: text("failure_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_ucl_team_user_provider").on(table.teamId, table.userId, table.provider),
    index("idx_ucl_user").on(table.userId),
    index("idx_ucl_external").on(table.provider, table.externalUserId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// FEDERATION — server-to-server trust + delivery
// ─────────────────────────────────────────────────────────────────────────────

/** Known remote servers (trust registry) */
export const federatedServers = sqliteTable("federated_servers", {
  host: text("host").primaryKey(),
  serverId: text("server_id").notNull(),
  publicKey: text("public_key").notNull(),
  displayName: text("display_name"),
  trustLevel: text("trust_level").notNull().default("pending"), // pending | trusted | blocked
  protocolVersion: text("protocol_version"),
  lastSeenAt: text("last_seen_at"),
  firstSeenAt: text("first_seen_at").notNull(),
  metadata: text("metadata", { mode: "json" }), // JSON: profiles, capabilities, federationInbox
});

/** Tez received from or sent to remote servers */
export const federatedTez = sqliteTable(
  "federated_tez",
  {
    id: text("id").primaryKey(),
    localTezId: text("local_tez_id")
      .notNull()
      .references(() => tez.id),
    remoteTezId: text("remote_tez_id").notNull(),
    remoteHost: text("remote_host").notNull(),
    direction: text("direction").notNull(), // "inbound" | "outbound"
    bundleHash: text("bundle_hash"),
    federatedAt: text("federated_at").notNull(),
  },
  (table) => [
    index("idx_ft_local_tez").on(table.localTezId),
    index("idx_ft_remote").on(table.remoteHost, table.remoteTezId),
  ]
);

/** Outbound federation delivery queue */
export const federationOutbox = sqliteTable(
  "federation_outbox",
  {
    id: text("id").primaryKey(),
    tezId: text("tez_id")
      .notNull()
      .references(() => tez.id),
    targetHost: text("target_host").notNull(),
    targetAddresses: text("target_addresses", { mode: "json" }).$type<string[]>().notNull(),
    bundle: text("bundle", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"), // pending | delivered | failed | expired
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: text("last_attempt_at"),
    nextRetryAt: text("next_retry_at"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
    error: text("error"),
  },
  (table) => [
    index("idx_fo_status").on(table.status),
    index("idx_fo_next_retry").on(table.nextRetryAt),
  ]
);
