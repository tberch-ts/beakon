// src/db.js
// SQLite storage layer.
//
// Driver strategy: prefer better-sqlite3 (fast, battle-tested) when it is
// installed. If it isn't available (e.g. native build tools missing), fall
// back to Node's built-in node:sqlite. Both expose the same
// prepare().run/get/all + exec() surface that the rest of the app uses, so
// nothing downstream needs to know which driver is active.
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

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  alert_email TEXT,
  stripe_customer_id TEXT,
  plan TEXT NOT NULL DEFAULT 'trial',
  subscription_status TEXT NOT NULL DEFAULT 'trialing',
  trial_ends_at INTEGER,
  created_at INTEGER NOT NULL
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
`);

export const now = () => Math.floor(Date.now() / 1000);
