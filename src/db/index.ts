import { drizzle } from "drizzle-orm/libsql";
import { createClient, type Client } from "@libsql/client";
import * as schema from "./schema.js";

const DATABASE_URL = process.env.DATABASE_URL || "file:./tezit-relay.db";

let _client: Client | null = null;
function getClient(): Client {
  if (!_client) {
    _client = createClient({ url: DATABASE_URL });
    _client.execute("PRAGMA journal_mode = WAL");
    _client.execute("PRAGMA busy_timeout = 5000");
    _client.execute("PRAGMA foreign_keys = ON");
  }
  return _client;
}

type DbType = ReturnType<typeof drizzle<typeof schema>>;
let _db: DbType | null = null;
function getDb(): DbType {
  if (!_db) {
    _db = drizzle(getClient(), { schema });
  }
  return _db;
}

// Proxy-based lazy db: defers creation until first access
export const db: DbType = new Proxy({} as DbType, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export { getClient };
export * from "./schema.js";
