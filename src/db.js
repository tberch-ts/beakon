// src/db.js
// SQLite storage layer.
//
// Driver strategy: prefer better-sqlite3 (fast, battle-tested) when it is
// installed. If it isn't available (e.g. native build tools missing), fall
// back to Node's built-in node:sqlite. Both expose the same
// prepare().run/get/all + exec() surface that the rest of the app uses, so
// nothing downstream needs to know which driver is active.
//
// Schema changes are additive and idempotent: `addColumn` checks PRAGMA
// table_info before altering, so the same code boots a fresh database and an
// existing production volume alike.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'beakon.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

async function openDb() {
  try {
    const { default: Database } = await import('better-sqlite3');
    const d = new Database(DB_PATH);
    d.pragma('journal_mode = WAL');
    console.log('[db] using better-sqlite3');
    return d;
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(DB_PATH);
    d.exec('PRAGMA journal_mode = WAL;');
    console.log('[db] using built-in node:sqlite');
    return d;
  }
}

export const db = await openDb();
export const now = () => Math.floor(Date.now() / 1000);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  -- Empty string for accounts that only ever signed in with Google.
  password_hash TEXT NOT NULL DEFAULT '',
  alert_email TEXT,
  stripe_customer_id TEXT,
  plan TEXT NOT NULL DEFAULT 'trial',
  subscription_status TEXT NOT NULL DEFAULT 'trialing',
  trial_ends_at INTEGER,
  created_at INTEGER NOT NULL
);

-- A client is a business whose sites are monitored together: one alert
-- address, one alert channel, one on/off switch, many monitors. CRM onboarding
-- creates one per CRM client; admins can create and merge them freely.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  crm_client_id INTEGER,
  domain TEXT,
  -- 'user' (self-serve), 'admin' (created in the admin UI), 'crm' (onboarded
  -- from marketingCRM).
  source TEXT NOT NULL DEFAULT 'user',
  alert_email TEXT,
  alert_email_verified_at INTEGER,
  alert_verify_token TEXT,
  alert_verify_expires_at INTEGER,
  -- 'none' | 'email' | 'kuma:<notificationId>'. Blank alert_email means
  -- nothing is sent regardless of the channel.
  alert_channel TEXT NOT NULL DEFAULT 'email',
  alerts_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Who may open a client's dashboard. Matched on email so access can be granted
-- before the person has ever signed in; user_id is filled in on first login.
CREATE TABLE IF NOT EXISTS client_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  user_id INTEGER,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  UNIQUE(client_id, email)
);

CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_checked_at INTEGER,
  last_response_ms INTEGER,
  last_error TEXT,
  ssl_expires_at INTEGER,
  ssl_warned_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_events_monitor ON events(monitor_id);

-- Search Ladder (see SEARCH-LADDER.md). One audit row per run per site; the
-- newest row per (client, domain) is the current grade. result_json holds the
-- full check results and the grade as computed at the time.
CREATE TABLE IF NOT EXISTS search_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  grade INTEGER NOT NULL,
  next_rung INTEGER,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- What a human confirmed in Google. scope_key is '*' for facts about the
-- business (its profile, its listings) and the domain for facts about one site
-- (Search Console, analytics, content).
CREATE TABLE IF NOT EXISTS search_attestations (
  client_id INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  set_by TEXT,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, scope_key, key)
);
`);

// ---- Additive migrations for databases created before these columns existed ----
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function addColumn(table, column, ddl) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

addColumn('users', 'firebase_uid', 'TEXT');
addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'customer'");
addColumn('users', 'last_login_at', 'INTEGER');

addColumn('monitors', 'client_id', 'INTEGER');
// Who added it: 'user' (counts against the plan), 'admin' or 'crm' (free).
addColumn('monitors', 'source', "TEXT NOT NULL DEFAULT 'user'");
addColumn('monitors', 'billable', 'INTEGER NOT NULL DEFAULT 1');
addColumn('monitors', 'type', "TEXT NOT NULL DEFAULT 'http'");
addColumn('monitors', 'keyword', 'TEXT');
addColumn('monitors', 'hostname', 'TEXT');
addColumn('monitors', 'port', 'INTEGER');
addColumn('monitors', 'interval_seconds', 'INTEGER NOT NULL DEFAULT 60');
addColumn('monitors', 'kuma_monitor_id', 'INTEGER');
addColumn('monitors', 'down_since', 'INTEGER');

// Google Business Profile Place ID, when known (from the CRM's NFC card, a
// Places lookup, or typed in). Rung 1 of the Search Ladder.
addColumn('clients', 'place_id', 'TEXT');
// The client's slug AS THE CRM KNOWS IT. Onboarding sets it to the CRM slug;
// a client created here by hand gets it typed in, and from then on the CRM's
// calls (/api/crm/clients/:slug/...) find this row.
addColumn('clients', 'crm_slug', 'TEXT');

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_monitors_client ON monitors(client_id);
CREATE INDEX IF NOT EXISTS idx_monitors_kuma ON monitors(kuma_monitor_id);
CREATE INDEX IF NOT EXISTS idx_client_users_email ON client_users(email);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_search_audits_client ON search_audits(client_id, domain, id);
CREATE INDEX IF NOT EXISTS idx_clients_crm_slug ON clients(crm_slug);
`);

// ---- Data migration: every pre-existing monitor gets a personal client ----
// Older rows belong to a user but not a client. Give each such user a client
// named after their email, move their monitors into it, and carry the alert
// address across. The address is treated as verified only when it is the login
// email itself (they proved they own that by signing in with it).
{
  const orphans = db.prepare(`
    SELECT DISTINCT u.* FROM users u JOIN monitors m ON m.user_id = u.id WHERE m.client_id IS NULL
  `).all();
  for (const u of orphans) {
    let client = db.prepare('SELECT * FROM clients WHERE slug = ?').get(`user-${u.id}`);
    if (!client) {
      const alertEmail = (u.alert_email || u.email || '').toLowerCase() || null;
      const verified = alertEmail && alertEmail === (u.email || '').toLowerCase() ? now() : null;
      const info = db.prepare(`
        INSERT INTO clients (slug, name, source, alert_email, alert_email_verified_at, alert_channel, alerts_enabled, created_at)
        VALUES (?, ?, 'user', ?, ?, 'email', 1, ?)
      `).run(`user-${u.id}`, u.email, alertEmail, verified, now());
      client = { id: info.lastInsertRowid };
      db.prepare('INSERT OR IGNORE INTO client_users (client_id, email, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(client.id, (u.email || '').toLowerCase(), u.id, 'owner', now());
    }
    db.prepare('UPDATE monitors SET client_id = ? WHERE user_id = ? AND client_id IS NULL').run(client.id, u.id);
    console.log(`[db] migrated monitors of ${u.email} into client #${client.id}`);
  }
}
