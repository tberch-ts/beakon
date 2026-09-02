// src/crm.js
// The two-way link with marketingCRM.
//
// Outbound: on a state transition Beakon POSTs a signal to the CRM's
// `/api/signals` (its contract is in the CRM README, "Beakon's side of the
// contract"). Fire-and-forget with a few retries; a CRM outage must never
// block a check or an alert.
//
// Inbound: when the CRM onboards a website customer it calls
// POST /api/crm/clients here with a shared secret, and Beakon creates (or
// updates) the client, grants the owner access, and adds a monitor per site.
// Those monitors are source='crm' and free to the customer.
import crypto from 'node:crypto';
import { now } from './db.js';
import { createClient, getClientBySlug, updateClient, grantAccess, updateAlertSettings } from './clients.js';
import { createMonitor, findMonitorByUrl, listMonitorsForClient } from './monitors.js';

const CRM_API_URL = (process.env.CRM_API_URL || '').replace(/\/+$/, '');
const CRM_SIGNAL_TOKEN = process.env.CRM_SIGNAL_TOKEN || '';
const CRM_WEBHOOK_TOKEN = process.env.CRM_WEBHOOK_TOKEN || '';

export function isCrmSignalConfigured() {
  return Boolean(CRM_API_URL && CRM_SIGNAL_TOKEN);
}
export function isCrmWebhookConfigured() {
  return Boolean(CRM_WEBHOOK_TOKEN);
}

/**
 * Post one transition to the CRM. dedupeKey is stable for a transition and
 * different for the next one, which is what makes CRM retries idempotent.
 */
export function postSignal({ monitor, kind, severity, detail, durationMinutes, transitionAt, suffix }) {
  if (!isCrmSignalConfigured()) return;
  const body = {
    url: monitor.url,
    kind,
    severity,
    durationMinutes: durationMinutes ?? null,
    detail: detail || null,
    monitorRef: String(monitor.id),
    observedAt: new Date().toISOString(),
    dedupeKey: `${monitor.id}:${kind}${suffix ? ':' + suffix : ''}:${transitionAt || now()}`,
  };
  // Not awaited by callers: run in the background with backoff.
  (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${CRM_API_URL}/api/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRM_SIGNAL_TOKEN}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          console.log(`[crm] signal ${kind} for #${monitor.id}: ${data.status || res.status}`);
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          console.warn(`[crm] signal rejected (${res.status}) for #${monitor.id}:`, await res.text().catch(() => ''));
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[crm] signal attempt ${attempt} failed for #${monitor.id}:`, err.message);
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
  })();
}

/** Bearer check for the inbound webhook; constant-time, fails closed. */
export function crmWebhookAuth(req, res, next) {
  if (!CRM_WEBHOOK_TOKEN) return res.status(503).json({ error: 'crm_webhook_not_configured' });
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(CRM_WEBHOOK_TOKEN);
  if (!provided || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/**
 * Upsert a client from the CRM.
 * payload = { slug, name, crmClientId?, domain?, ownerEmail?, owners?: [email],
 *             alertEmail?, sites?: [{ name?, url }] }
 */
export async function upsertClientFromCrm(payload, { baseUrl }) {
  const slug = String(payload.slug || '').trim().toLowerCase();
  const name = String(payload.name || '').trim();
  if (!slug || !name) throw new Error('slug and name are required');
  const domain = payload.domain ? String(payload.domain).trim().toLowerCase() : null;
  const crmClientId = payload.crmClientId != null ? Number(payload.crmClientId) : null;

  let client = getClientBySlug(slug);
  let created = false;
  if (client) {
    client = updateClient(client.id, { name, domain: domain ?? client.domain, crmClientId: crmClientId ?? client.crm_client_id });
  } else {
    client = createClient({ name, slug, source: 'crm', domain, crmClientId });
    created = true;
  }

  const owners = [payload.ownerEmail, ...(Array.isArray(payload.owners) ? payload.owners : [])]
    .map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@'));
  for (const email of owners) grantAccess(client.id, email);

  // The alert address is only set when the CRM gives one and the client has
  // none yet; it still has to be verified by the person at that address, and
  // the verification mail goes out once, here. Leaving it blank means silence.
  let verificationSent = false;
  if (payload.alertEmail && !client.alert_email) {
    const r = await updateAlertSettings(client, { alertEmail: payload.alertEmail, alertChannel: 'email', alertsEnabled: 1 }, { baseUrl });
    client = r.client;
    verificationSent = r.verificationSent;
  }

  const sites = [];
  if (Array.isArray(payload.sites)) sites.push(...payload.sites);
  if (!sites.length && domain) sites.push({ name, url: domain });
  const monitors = [];
  for (const s of sites) {
    const url = s?.url || s?.domain;
    if (!url) continue;
    const existing = findMonitorByUrl(client.id, url);
    if (existing) { monitors.push({ id: existing.id, url: existing.url, created: false }); continue; }
    try {
      const m = await createMonitor({ clientId: client.id, userId: 0, name: s.name || name, url, type: 'http', source: 'crm' });
      monitors.push({ id: m.id, url: m.url, created: true });
    } catch (err) {
      monitors.push({ url, error: err.message });
    }
  }

  return { client, created, owners, verificationSent, monitors, monitorCount: listMonitorsForClient(client.id).length };
}

export function clientStatusForCrm(client) {
  const monitors = listMonitorsForClient(client.id).map((m) => ({
    id: m.id, name: m.name, url: m.url, type: m.type, active: Boolean(m.active), status: m.last_status,
    lastCheckedAt: m.last_checked_at, responseMs: m.last_response_ms, sslExpiresAt: m.ssl_expires_at, source: m.source,
  }));
  return { client: { id: client.id, slug: client.slug, name: client.name, domain: client.domain, alertEmail: client.alert_email, alertVerified: Boolean(client.alert_email_verified_at), alertsEnabled: Boolean(client.alerts_enabled) }, monitors };
}
