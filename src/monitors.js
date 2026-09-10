// src/monitors.js
// Monitor CRUD, and keeping Uptime Kuma in step with it.
//
// Beakon's `monitors` table is the source of truth: which client a monitor
// rolls up into and whether it is switched on. When Kuma is
// enabled every row is mirrored to a Kuma monitor (kuma_monitor_id); Kuma does
// the checking and its heartbeats flow back through engine.js. Kuma calls are
// best-effort — a Kuma outage must never stop someone adding a monitor — and
// reconcileKuma() repairs any drift on the next sweep.
import { db, now } from './db.js';
import { normalizeUrl } from './checks.js';
import { kuma, isKumaEnabled, toKumaSpec, hostOf } from './kuma.js';
import { getClient, kumaNotificationIdForClient } from './clients.js';

const VALID_TYPES = new Set(['http', 'keyword', 'ping', 'port', 'dns']);

export function getMonitor(id) {
  return db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) || null;
}

export function listMonitorsForClient(clientId) {
  return db.prepare('SELECT * FROM monitors WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
}

/** Admin: everything, with client and owner names attached. */
export function listAllMonitors() {
  return db.prepare(`
    SELECT m.*, c.name AS client_name, c.slug AS client_slug
    FROM monitors m
    LEFT JOIN clients c ON c.id = m.client_id
    ORDER BY c.name COLLATE NOCASE, m.created_at DESC
  `).all();
}

export function recentEvents(limit = 50, clientId = null) {
  const sql = `
    SELECT e.*, m.name AS monitor_name, m.url AS monitor_url, m.client_id, c.name AS client_name
    FROM events e JOIN monitors m ON m.id = e.monitor_id LEFT JOIN clients c ON c.id = m.client_id
    ${clientId ? 'WHERE m.client_id = ?' : ''}
    ORDER BY e.created_at DESC LIMIT ?`;
  return clientId ? db.prepare(sql).all(clientId, limit) : db.prepare(sql).all(limit);
}

/** Create a monitor. `source` records who added it: 'admin' here, 'crm' from onboarding. */
export async function createMonitor({ clientId, userId, name, url, type = 'http', keyword = null, hostname = null, port = null, source = 'admin', intervalSeconds = 60 }) {
  if (!VALID_TYPES.has(type)) type = 'http';
  const needsUrl = type === 'http' || type === 'keyword';
  let finalUrl;
  if (needsUrl || url) finalUrl = normalizeUrl(url);
  else finalUrl = `https://${String(hostname || '').trim()}`;
  const host = hostname ? String(hostname).trim() : hostOf(finalUrl);
  if (!host) throw new Error('hostname required');
  if (type === 'keyword' && !String(keyword || '').trim()) throw new Error('keyword required');
  if (type === 'port' && !(Number(port) > 0)) throw new Error('port required');

  const billable = 0; // column kept for old rows; nothing is billed any more
  const finalName = String(name || host).trim().slice(0, 120);
  const info = db.prepare(`
    INSERT INTO monitors (user_id, client_id, name, url, type, keyword, hostname, port, interval_seconds, source, billable, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(userId ?? 0, clientId, finalName, finalUrl, type, keyword ? String(keyword).trim() : null, host, port ? Number(port) : null,
    Math.max(20, Number(intervalSeconds) || 60), source, billable, now());
  const monitor = getMonitor(info.lastInsertRowid);
  await syncMonitorToKuma(monitor).catch((err) => console.error(`[kuma] sync #${monitor.id} failed:`, err.message));
  return getMonitor(monitor.id);
}

export function findMonitorByUrl(clientId, url) {
  let u;
  try { u = normalizeUrl(url); } catch { return null; }
  const host = hostOf(u);
  return db.prepare('SELECT * FROM monitors WHERE client_id = ? AND (url = ? OR hostname = ?)').get(clientId, u, host) || null;
}

export async function setMonitorActive(id, active) {
  const m = getMonitor(id);
  if (!m) return null;
  db.prepare('UPDATE monitors SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (kumaReady() && m.kuma_monitor_id) {
    await (active ? kuma.resumeMonitor(m.kuma_monitor_id) : kuma.pauseMonitor(m.kuma_monitor_id))
      .catch((err) => console.error(`[kuma] ${active ? 'resume' : 'pause'} #${id} failed:`, err.message));
  }
  return getMonitor(id);
}

export async function deleteMonitor(id) {
  const m = getMonitor(id);
  if (!m) return;
  db.prepare('DELETE FROM events WHERE monitor_id = ?').run(id);
  db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  if (kumaReady() && m.kuma_monitor_id) {
    await kuma.deleteMonitor(m.kuma_monitor_id).catch((err) => console.error(`[kuma] delete #${id} failed:`, err.message));
  }
}

export async function updateMonitor(id, { name, intervalSeconds }) {
  const m = getMonitor(id);
  if (!m) return null;
  db.prepare('UPDATE monitors SET name = ?, interval_seconds = ? WHERE id = ?')
    .run(name ? String(name).trim().slice(0, 120) : m.name, Math.max(20, Number(intervalSeconds) || m.interval_seconds), id);
  await syncMonitorToKuma(getMonitor(id)).catch((err) => console.error(`[kuma] sync #${id} failed:`, err.message));
  return getMonitor(id);
}

/** Move a monitor into another client (rolling several sites into one client). */
export async function assignMonitorToClient(id, clientId) {
  if (!getClient(clientId)) throw new Error('no such client');
  db.prepare('UPDATE monitors SET client_id = ? WHERE id = ?').run(clientId, id);
  await syncMonitorToKuma(getMonitor(id)).catch((err) => console.error(`[kuma] sync #${id} failed:`, err.message));
}

// ---- Kuma mirroring ----
function kumaReady() {
  return isKumaEnabled() && kuma && kuma.isReady();
}

/** Should this monitor be checking right now? */
export function desiredActive(m) {
  return Boolean(m.active);
}

/** Create or update the Kuma twin of one monitor. */
export async function syncMonitorToKuma(m) {
  if (!kumaReady() || !m) return;
  const client = m.client_id ? getClient(m.client_id) : null;
  const notifId = kumaNotificationIdForClient(client);
  const spec = toKumaSpec(m, notifId ? [notifId] : []);
  if (m.kuma_monitor_id && kuma.monitors[m.kuma_monitor_id]) {
    await kuma.editMonitor(spec);
  } else {
    delete spec.id;
    const kumaId = await kuma.addMonitor(spec);
    db.prepare('UPDATE monitors SET kuma_monitor_id = ? WHERE id = ?').run(kumaId, m.id);
    m.kuma_monitor_id = kumaId;
  }
  const want = desiredActive(m);
  const have = kuma.monitors[m.kuma_monitor_id]?.active;
  if (have !== undefined && Boolean(have) !== want) {
    await (want ? kuma.resumeMonitor(m.kuma_monitor_id) : kuma.pauseMonitor(m.kuma_monitor_id));
  } else if (have === undefined && !want) {
    await kuma.pauseMonitor(m.kuma_monitor_id);
  }
}

/** Re-push every monitor of a client (after its alert channel changed). */
export async function syncClientMonitorsToKuma(clientId) {
  if (!kumaReady()) return;
  for (const m of listMonitorsForClient(clientId)) {
    await syncMonitorToKuma(m).catch((err) => console.error(`[kuma] sync #${m.id} failed:`, err.message));
  }
}

/**
 * Bring Kuma in line with the table: create missing twins, pause/resume to
 * match the desired state. Returns Kuma monitors nobody here references, so
 * the admin can import them into a client.
 */
export async function reconcileKuma() {
  if (!kumaReady()) return { synced: 0, unlinked: [] };
  const rows = db.prepare('SELECT * FROM monitors').all();
  const known = new Set();
  let synced = 0;
  for (const m of rows) {
    if (m.kuma_monitor_id) known.add(Number(m.kuma_monitor_id));
    try {
      const missing = !m.kuma_monitor_id || !kuma.monitors[m.kuma_monitor_id];
      const want = desiredActive(m);
      const have = m.kuma_monitor_id ? Boolean(kuma.monitors[m.kuma_monitor_id]?.active) : null;
      if (missing || have !== want) {
        await syncMonitorToKuma(m);
        known.add(Number(m.kuma_monitor_id));
        synced++;
      }
    } catch (err) {
      console.error(`[kuma] reconcile #${m.id} failed:`, err.message);
    }
  }
  const unlinked = Object.values(kuma.monitors)
    .filter((km) => !known.has(Number(km.id)) && km.type !== 'group')
    .map((km) => ({ id: km.id, name: km.name, type: km.type, url: km.url, hostname: km.hostname, port: km.port, active: km.active }));
  return { synced, unlinked };
}

export function unlinkedKumaMonitors() {
  if (!kumaReady()) return [];
  const known = new Set(db.prepare('SELECT kuma_monitor_id FROM monitors WHERE kuma_monitor_id IS NOT NULL').all().map((r) => Number(r.kuma_monitor_id)));
  return Object.values(kuma.monitors)
    .filter((km) => !known.has(Number(km.id)) && km.type !== 'group')
    .map((km) => ({ id: km.id, name: km.name, type: km.type, url: km.url, hostname: km.hostname, port: km.port, active: km.active }));
}

/** Adopt a monitor that was created directly in Kuma's UI into a client. */
export async function importKumaMonitor(kumaId, clientId, userId) {
  if (!kumaReady()) throw new Error('Uptime Kuma is not connected');
  const km = kuma.monitors[kumaId] || (await kuma.getMonitor(kumaId));
  if (!km) throw new Error('no such Kuma monitor');
  if (db.prepare('SELECT 1 FROM monitors WHERE kuma_monitor_id = ?').get(kumaId)) throw new Error('already linked');
  const type = VALID_TYPES.has(km.type) ? km.type : 'http';
  const url = km.url && /^https?:/i.test(km.url) ? km.url : `https://${km.hostname || 'unknown'}`;
  const info = db.prepare(`
    INSERT INTO monitors (user_id, client_id, name, url, type, keyword, hostname, port, interval_seconds, source, billable, active, kuma_monitor_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 0, ?, ?, ?)
  `).run(userId ?? 0, clientId, km.name, url, type, km.keyword || null, km.hostname || hostOf(url), km.port || null,
    Math.max(20, Number(km.interval) || 60), km.active ? 1 : 0, kumaId, now());
  const m = getMonitor(info.lastInsertRowid);
  await syncMonitorToKuma(m).catch((err) => console.error(`[kuma] sync imported #${m.id} failed:`, err.message));
  return getMonitor(m.id);
}
