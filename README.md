# tezit-relay

Open relay server for the [Tezit Protocol](https://github.com/tezit-protocol/spec). Securely deliver and persist context-rich messages across federated platforms.

## What is a Tez?

A Tez is a message with an iceberg of context beneath it. When someone sends you a Tez, you see the surface ("Review the Q4 budget") but can dive into the depth: why they're asking, what led to this, who's involved, the actual documents, a voice note explaining the tricky part.

**tezit-relay handles the delivery, persistence, and federation. Your AI handles the context assembly.**

## Architecture

```
Platform A (MyPA, etc.)          Platform B
  ↓ assembles tez                  ↑ receives tez
tezit-relay (Node A)  ←──────→  tezit-relay (Node B)
  Ed25519 signed HTTP              Ed25519 verified
  federation delivery              federation inbox
```

- **Express + TypeScript + Drizzle ORM + SQLite**
- Ed25519 keypair identity per relay node (auto-generated on first boot)
- HTTP signatures (simplified RFC 9421) for server-to-server authentication
- Litestream for continuous SQLite replication to object storage
- Append-only audit log for every mutation
- Team ACLs enforced on every query and write
- pm2 for process management in production

## Quick Start

```bash
git clone https://github.com/tezit-protocol/relay.git
cd relay
cp .env.example .env
npm install
npm run dev
```

The relay starts on port 3002. On first boot, it generates an Ed25519 keypair in `DATA_DIR` and derives its server ID (first 16 hex chars of SHA-256 of the public key).

## API

### Core Messaging
```
POST   /tez/share              Send a Tez (create + deliver)
GET    /tez/stream              SSE feed for authenticated user
POST   /tez/:id/reply           Reply to a Tez (threaded)
GET    /tez/:id                 Get full Tez with context + provenance
GET    /tez/:id/thread          Get full thread
```

### Teams & Contacts
```
POST   /teams                   Create team
GET    /teams/:id/members       List members
POST   /teams/:id/members       Add member (admin)
DELETE /teams/:id/members/:uid  Remove member
GET    /contacts                List contacts
POST   /contacts                Add contact
```

### Federation
```
POST   /federation/inbox        Receive a Tez from a remote server
GET    /federation/server-info  Public server identity + capabilities
POST   /federation/verify       Trust handshake (register remote server)
```

### Admin
```
GET    /admin/federation/servers        List known federated servers
PATCH  /admin/federation/servers/:host  Update trust level (pending/trusted/blocked)
DELETE /admin/federation/servers/:host  Remove server
GET    /admin/federation/outbox         View delivery queue
```

### Discovery
```
GET    /.well-known/tezit.json  Server discovery document
GET    /health                  Liveness check
```

## Federation

Relay nodes communicate using Ed25519-signed HTTP requests. The federation flow:

1. **Discovery**: Remote server queries `/.well-known/tezit.json` to learn your capabilities
2. **Verification**: Remote server calls `POST /federation/verify` with its host, server_id, and public_key
3. **Trust**: In `open` mode, servers are auto-trusted. In `allowlist` mode, an admin must promote them.
4. **Delivery**: Tezits are bundled with context, SHA-256 hashed for integrity, signed, and POSTed to the remote server's federation inbox
5. **Welcome Cookie**: Newly trusted peers receive a welcome tez containing the Nestle Toll House cookie recipe as an easter egg and smoke test

### Trust Models

- **Allowlist** (default): Only admin-approved servers can exchange tezits. Best for enterprise.
- **Open**: Any server with a valid Ed25519 signature is auto-trusted. Best for community/research.

### Bundle Format

Federation bundles include:
- Protocol version, sender identity, addressing
- Tez payload (surface text, type, urgency, action)
- Context array (layers with content, MIME type, confidence, source)
- SHA-256 integrity hash
- Ed25519 HTTP signature timestamp

## Auth

tezit-relay does not manage users or passwords. It verifies JWTs from whatever auth system you use. Your JWT must contain a `sub` claim (user ID). Set `JWT_SECRET` in `.env`.

## Database

SQLite with Drizzle ORM. 12+ tables covering:

| Table | Purpose |
|-------|---------|
| `teams` | Team definitions |
| `team_members` | Team membership + roles |
| `tez` | Core tez storage |
| `tez_context` | Context layers per tez |
| `tez_recipients` | Delivery tracking |
| `contacts` | Contact registry |
| `conversations` | Thread grouping |
| `conversation_members` | Conversation participants |
| `audit_log` | Append-only mutation log |
| `federated_servers` | Known federation peers + trust levels |
| `federated_tez` | Cross-server tez tracking |
| `federation_outbox` | Delivery queue with retry |

## Configuration

See `.env.example` for all options:

```env
PORT=3002
DATABASE_URL=file:./tezit-relay.db
JWT_SECRET=change-me-in-production
RELAY_HOST=relay.example.com
FEDERATION_ENABLED=true
FEDERATION_MODE=allowlist
DATA_DIR=./data
ADMIN_USER_IDS=user-id-1,user-id-2
```

## Deployment

Production deployment scripts are in `deploy/`:

- `provision.sh` — Initial server setup (Node.js, nginx, certbot, Litestream)
- `deploy.sh` — Build and deploy new code
- `ssl-setup.sh` — Let's Encrypt SSL certificate
- `litestream-setup.sh` — Continuous SQLite replication
- `health-monitor.sh` — Health check cron
- `ecosystem.config.cjs` — pm2 process config
- `nginx-relay.conf` — nginx reverse proxy config

## Running Your Own Relay

1. Provision a server (512MB RAM is sufficient)
2. Clone this repo and run `deploy/provision.sh`
3. Configure `.env` with your domain and secrets
4. Run `deploy/ssl-setup.sh` for HTTPS
5. Run `deploy/litestream-setup.sh` for backups
6. Start with `pm2 start deploy/ecosystem.config.cjs`

The first production relay node runs at `relay.tezit.com`.

## Protocol Specification

- [Tezit Protocol Spec v1.2](https://github.com/tezit-protocol/spec/blob/main/TEZIT_PROTOCOL_SPEC_v1.2.md)
- [TIP (Tez Interrogation Protocol)](https://github.com/tezit-protocol/spec/blob/main/TEZ_INTERROGATION_PROTOCOL.md)
- [HTTP API Spec](https://github.com/tezit-protocol/spec/blob/main/TEZ_HTTP_API_SPEC.md)
- [Documentation](https://tezit.com/docs)

## License

AGPL-3.0 — use it, self-host it, extend it. If you modify the server, share your changes.
