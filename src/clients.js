// src/clients.js
// Clients: a business whose sites are monitored together, and who gets told.
// See the `clients` table comment in db.js. Customers do not sign in here —
// they get an Uptime Kuma status page — so there is no access model.
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { sendVerificationEmail } from './mailer.js';

const VERIFY_TTL_SECONDS = 7 * 86400;

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'client';
}

function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
}
export function getClientBySlug(slug) {
  return db.prepare('SELECT * FROM clients WHERE slug = ?').get(slug) || null;
}

/** Normalise a CRM slug: the CRM's own rule is lowercase, digits, single hyphens. */
export function normalizeCrmSlug(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) throw new Error('CRM slug must be lowercase letters, digits and single hyphens, e.g. "joes-barber"');
  return s;
}

/**
 * Find the client the CRM means by a slug: crm_slug first (the field that
 * exists for exactly this), then Beakon's own slug (onboarding made them equal).
 */
export function getClientByCrmSlug(slug) {
  const s = String(slug || '').toLowerCase();
  if (!s) return null;
  return db.prepare('SELECT * FROM clients WHERE crm_slug = ?').get(s)
    || db.prepare('SELECT * FROM clients WHERE slug = ? AND crm_slug IS NULL').get(s)
    || null;
}

function assertCrmSlugFree(crmSlug, exceptId = null) {
  if (!crmSlug) return;
  const other = db.prepare('SELECT id, name FROM clients WHERE crm_slug = ? AND id != ?').get(crmSlug, exceptId ?? -1);
  if (other) throw new Error(`CRM slug "${crmSlug}" is already on client "${other.name}"`);
}

export function createClient({ name, slug, crmSlug = null, source = 'admin', domain = null, crmClientId = null, alertEmail = null, alertChannel = 'email' }) {
  const finalSlug = uniqueSlug(slugify(slug || name));
  const crm = normalizeCrmSlug(crmSlug);
  assertCrmSlugFree(crm);
  const info = db.prepare(`
    INSERT INTO clients (slug, name, crm_slug, crm_client_id, domain, source, alert_email, alert_channel, alerts_enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(finalSlug, String(name).trim().slice(0, 120), crm, crmClientId, domain, source, alertEmail ? alertEmail.toLowerCase() : null, alertChannel, now());
  return getClient(info.lastInsertRowid);
}

export function updateClient(id, { name, domain, crmSlug, crmClientId }) {
  const c = getClient(id);
  if (!c) return null;
  const crm = crmSlug === undefined ? c.crm_slug : normalizeCrmSlug(crmSlug);
  assertCrmSlugFree(crm, id);
  db.prepare('UPDATE clients SET name = ?, domain = ?, crm_slug = ?, crm_client_id = ? WHERE id = ?')
    .run(name ?? c.name, domain ?? c.domain, crm, crmClientId ?? c.crm_client_id, id);
  return getClient(id);
}

/** Admin view: every client with monitor counts and status roll-up. */
export function listClients() {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM monitors m WHERE m.client_id = c.id) AS monitor_count,
      (SELECT COUNT(*) FROM monitors m WHERE m.client_id = c.id AND m.active = 1 AND m.last_status = 'down') AS down_count
    FROM clients c ORDER BY c.name COLLATE NOCASE
  `).all();
}

/**
 * How alerts for this client actually go out right now.
 *   'none'             - switched off, or no address
 *   'email_unverified' - address set but not yet confirmed: nothing is sent
 *   'email'            - Beakon emails the verified address
 *   'kuma'             - an Uptime Kuma notification channel is attached
 */
export function effectiveAlertMode(client) {
  if (!client || !client.alerts_enabled) return 'none';
  const ch = client.alert_channel || 'email';
  if (ch.startsWith('kuma:')) return 'kuma';
  if (ch === 'none') return 'none';
  if (!client.alert_email) return 'none';
  return client.alert_email_verified_at ? 'email' : 'email_unverified';
}

export function kumaNotificationIdForClient(client) {
  const ch = client?.alert_channel || '';
  if (!client?.alerts_enabled || !ch.startsWith('kuma:')) return null;
  const id = parseInt(ch.slice(5), 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Save alert settings. A changed address is unverified until the person at
 * that address clicks the link we send — once, on change, never nagging. A
 * blank address simply switches email alerts off. Admins may pass
 * markVerified to skip the round-trip for an address they know is right.
 */
export async function updateAlertSettings(client, { alertEmail, alertChannel, alertsEnabled, markVerified = false }, { baseUrl }) {
  const email = String(alertEmail ?? client.alert_email ?? '').trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That alert email looks invalid.');
  let channel = String(alertChannel ?? client.alert_channel ?? 'email');
  if (!(channel === 'none' || channel === 'email' || /^kuma:\d+$/.test(channel))) channel = 'email';
  const enabled = alertsEnabled == null ? client.alerts_enabled : (alertsEnabled ? 1 : 0);

  const changed = email !== (client.alert_email || null);
  let verifiedAt = changed ? null : client.alert_email_verified_at;
  let token = changed ? null : client.alert_verify_token;
  let expires = changed ? null : client.alert_verify_expires_at;
  let sent = false;

  if (email && markVerified) {
    verifiedAt = now(); token = null; expires = null;
  } else if (email && !verifiedAt) {
    token = crypto.randomBytes(24).toString('base64url');
    expires = now() + VERIFY_TTL_SECONDS;
    sent = await sendVerificationEmail(email, `${baseUrl}/alerts/verify?token=${token}`, client.name);
  }

  db.prepare(`
    UPDATE clients SET alert_email = ?, alert_email_verified_at = ?, alert_verify_token = ?, alert_verify_expires_at = ?,
      alert_channel = ?, alerts_enabled = ? WHERE id = ?
  `).run(email, verifiedAt, token, expires, channel, enabled, client.id);
  return { client: getClient(client.id), verificationSent: sent, verificationPending: Boolean(email && !verifiedAt) };
}

export async function resendVerification(client, { baseUrl }) {
  if (!client.alert_email || client.alert_email_verified_at) return false;
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE clients SET alert_verify_token = ?, alert_verify_expires_at = ? WHERE id = ?')
    .run(token, now() + VERIFY_TTL_SECONDS, client.id);
  return sendVerificationEmail(client.alert_email, `${baseUrl}/alerts/verify?token=${token}`, client.name);
}

export function verifyAlertToken(token) {
  if (!token) return null;
  const c = db.prepare('SELECT * FROM clients WHERE alert_verify_token = ?').get(token);
  if (!c) return null;
  if (c.alert_verify_expires_at && c.alert_verify_expires_at < now()) return null;
  db.prepare('UPDATE clients SET alert_email_verified_at = ?, alert_verify_token = NULL, alert_verify_expires_at = NULL WHERE id = ?')
    .run(now(), c.id);
  return getClient(c.id);
}

export function deleteClient(id) {
  db.prepare('DELETE FROM client_users WHERE client_id = ?').run(id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}
