// src/engine.js
// Turns observations into state, events, alerts and CRM signals — whichever
// checker produced them. The built-in sweeper (monitor.js) and Uptime Kuma
// heartbeats both end up in applyObservation(), so alert rules live in exactly
// one place.
import { db, now } from './db.js';
import { sendAlert } from './mailer.js';
import { getClient, effectiveAlertMode } from './clients.js';
import { postSignal } from './crm.js';

const SSL_WARN_DAYS = parseInt(process.env.SSL_WARN_DAYS || '14', 10);

function logEvent(monitorId, kind, detail) {
  db.prepare('INSERT INTO events (monitor_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(monitorId, kind, detail || null, now());
}

/**
 * Deliver an alert for a client's monitor, if that client wants one.
 *   - alerts switched off, or no address: nothing, quietly
 *   - address not yet verified: nothing (the verification mail was sent once)
 *   - verified email: Beakon sends it
 *   - Kuma channel: Kuma already sent it; we only record that
 */
async function notify(monitor, kind, subject, text) {
  const client = monitor.client_id ? getClient(monitor.client_id) : null;
  const mode = effectiveAlertMode(client);
  if (mode === 'email') {
    const ok = await sendAlert(client.alert_email, subject, text);
    logEvent(monitor.id, 'alert_email', `${kind} → ${client.alert_email}${ok ? '' : ' (not delivered)'}`);
  } else if (mode === 'kuma') {
    logEvent(monitor.id, 'alert_kuma', `${kind} via Uptime Kuma channel ${client.alert_channel}`);
  }
  // 'none' and 'email_unverified' are silent by design.
}

function label(m) {
  return `${m.name} (${m.type === 'http' || m.type === 'keyword' ? m.url : m.hostname || m.url})`;
}

/**
 * Record one check result for a monitor.
 * obs = { up: true|false|null, responseMs, error, sslExpiresAt, via }
 * `up: null` means "pending / no verdict" and is ignored.
 */
export async function applyObservation(monitorId, obs) {
  const m = db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitorId);
  if (!m) return;
  const t = now();

  if (obs.up === true || obs.up === false) {
    const status = obs.up ? 'up' : 'down';
    const prev = m.last_status;
    db.prepare(`
      UPDATE monitors SET last_status = ?, last_checked_at = ?, last_response_ms = ?, last_error = ?,
        ssl_expires_at = COALESCE(?, ssl_expires_at),
        down_since = CASE WHEN ? = 'down' THEN COALESCE(down_since, ?) ELSE NULL END
      WHERE id = ?
    `).run(status, t, obs.responseMs ?? null, obs.error || null, obs.sslExpiresAt || null, status, t, m.id);

    if (status === 'down' && prev !== 'down') {
      const detail = obs.error || 'check failed';
      logEvent(m.id, 'down', detail);
      await notify(m, 'down', `🔴 DOWN: ${m.name}`,
        `${label(m)} is DOWN.\nReason: ${detail}\nDetected: ${new Date(t * 1000).toUTCString()}\n\n— Beakon`);
      postSignal({ monitor: m, kind: 'down', severity: 'critical', detail, durationMinutes: 0, transitionAt: t });
    } else if (status === 'up' && prev === 'down') {
      const downFor = m.down_since ? Math.max(1, Math.round((t - m.down_since) / 60)) : null;
      const detail = `recovered in ${obs.responseMs ?? '?'}ms${downFor ? ` after ${downFor} min down` : ''}`;
      logEvent(m.id, 'up', detail);
      await notify(m, 'recovered', `🟢 RECOVERED: ${m.name}`,
        `${label(m)} is back UP.\nResponse: ${obs.responseMs ?? '?'}ms${downFor ? `\nDowntime: ${downFor} minute(s)` : ''}\nRecovered: ${new Date(t * 1000).toUTCString()}\n\n— Beakon`);
      postSignal({ monitor: m, kind: 'recovered', severity: 'info', detail, durationMinutes: downFor, transitionAt: t });
    } else if (status === 'down' && m.down_since) {
      // Still down: let the CRM know once it has been long enough to matter.
      const mins = Math.round((t - m.down_since) / 60);
      if (mins >= 240 && !recentlyLogged(m.id, 'down_4h')) {
        logEvent(m.id, 'down_4h', `down for ${mins} min`);
        postSignal({ monitor: m, kind: 'down', severity: 'critical', detail: m.last_error || obs.error || 'still down', durationMinutes: mins, transitionAt: m.down_since, suffix: '4h' });
      }
    }
  } else if (obs.sslExpiresAt) {
    db.prepare('UPDATE monitors SET ssl_expires_at = ? WHERE id = ?').run(obs.sslExpiresAt, m.id);
  }

  // SSL expiry: warn at most once per 24h per monitor, and only for alert-worthy windows.
  const expiresAt = obs.sslExpiresAt || (obs.up == null ? m.ssl_expires_at : null);
  if (expiresAt) {
    const daysLeft = Math.floor((expiresAt - t) / 86400);
    const warnedRecently = m.ssl_warned_at && t - m.ssl_warned_at < 86400;
    if (daysLeft <= SSL_WARN_DAYS && !warnedRecently) {
      db.prepare('UPDATE monitors SET ssl_warned_at = ? WHERE id = ?').run(t, m.id);
      const expired = daysLeft < 0;
      const kind = expired ? 'cert_expired' : 'cert_expiring';
      logEvent(m.id, expired ? 'ssl_expired' : 'ssl_warning', `${daysLeft} days left`);
      await notify(m, kind,
        expired ? `⛔ SSL EXPIRED: ${m.name}` : `⚠️ SSL expiring in ${daysLeft}d: ${m.name}`,
        `The SSL certificate for ${label(m)} ${expired ? 'expired' : 'expires'} on ${new Date(expiresAt * 1000).toUTCString()}${expired ? '' : ` (${daysLeft} day(s) left)`}.\n\n— Beakon`);
      postSignal({ monitor: m, kind, severity: expired ? 'critical' : 'warning', detail: `${daysLeft} days to expiry`, durationMinutes: null, transitionAt: Math.floor(expiresAt / 86400) * 86400 });
    }
  }
}

function recentlyLogged(monitorId, kind, withinSeconds = 86400) {
  const row = db.prepare('SELECT created_at FROM events WHERE monitor_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1').get(monitorId, kind);
  return Boolean(row && now() - row.created_at < withinSeconds);
}

/** Adapter: an Uptime Kuma heartbeat → applyObservation. */
export async function applyKumaHeartbeat(beat) {
  const kumaId = Number(beat.monitorID ?? beat.monitor_id);
  if (!kumaId) return;
  const m = db.prepare('SELECT id, last_status FROM monitors WHERE kuma_monitor_id = ?').get(kumaId);
  if (!m) return;
  // 0 DOWN, 1 UP, 2 PENDING (retrying), 3 MAINTENANCE — only 0/1 are verdicts.
  const up = beat.status === 1 ? true : beat.status === 0 ? false : null;
  if (up === null) return;
  // Replayed history on reconnect only matters if it disagrees with what we have.
  if (beat.replay && m.last_status === (up ? 'up' : 'down')) return;
  await applyObservation(m.id, { up, responseMs: beat.ping ?? null, error: up ? null : (beat.msg || 'down'), via: 'kuma' });
}

/** Adapter: Uptime Kuma certInfo → SSL expiry on the monitor. */
export async function applyKumaCertInfo({ monitorID, info }) {
  const m = db.prepare('SELECT id FROM monitors WHERE kuma_monitor_id = ?').get(Number(monitorID));
  if (!m || !info) return;
  const ci = info.certInfo || info;
  let expiresAt = null;
  if (ci.validTo) expiresAt = Math.floor(new Date(ci.validTo).getTime() / 1000);
  else if (typeof ci.daysRemaining === 'number') expiresAt = now() + ci.daysRemaining * 86400;
  if (!expiresAt || Number.isNaN(expiresAt)) return;
  await applyObservation(m.id, { up: null, sslExpiresAt: expiresAt, via: 'kuma' });
}
