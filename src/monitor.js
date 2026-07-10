// src/monitor.js
// Background scheduler. Sweeps active monitors on an interval, runs checks,
// records status transitions, and fires email alerts on changes.
import { db, now } from './db.js';
import { httpCheck, sslCheck } from './checks.js';
import { sendAlert } from './mailer.js';
import { isAccountActive } from './plans.js';

const SSL_WARN_DAYS = parseInt(process.env.SSL_WARN_DAYS || '14', 10);
const INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10) * 1000;

function logEvent(monitorId, kind, detail) {
  db.prepare('INSERT INTO events (monitor_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(monitorId, kind, detail || null, now());
}

async function checkMonitor(monitor, user) {
  const result = await httpCheck(monitor.url);
  const ssl = await sslCheck(monitor.url);
  const status = result.up ? 'up' : 'down';
  const prev = monitor.last_status;

  const update = db.prepare(`
    UPDATE monitors
    SET last_status = ?, last_checked_at = ?, last_response_ms = ?, last_error = ?,
        ssl_expires_at = COALESCE(?, ssl_expires_at)
    WHERE id = ?
  `);
  update.run(status, now(), result.responseMs, result.error, ssl.expiresAt, monitor.id);

  const alertTo = user.alert_email || user.email;

  // Status transition alerts (only when state actually changes).
  if (prev && prev !== status) {
    if (status === 'down') {
      logEvent(monitor.id, 'down', result.error);
      await sendAlert(
        alertTo,
        `🔴 DOWN: ${monitor.name}`,
        `${monitor.name} (${monitor.url}) is DOWN.\nReason: ${result.error}\nDetected: ${new Date().toUTCString()}\n\n— Beakon`
      );
    } else {
      logEvent(monitor.id, 'up', `recovered in ${result.responseMs}ms`);
      await sendAlert(
        alertTo,
        `🟢 RECOVERED: ${monitor.name}`,
        `${monitor.name} (${monitor.url}) is back UP.\nResponse: ${result.responseMs}ms\nRecovered: ${new Date().toUTCString()}\n\n— Beakon`
      );
    }
  } else if (!prev && status === 'down') {
    // First-ever check is already down — alert once.
    logEvent(monitor.id, 'down', result.error);
    await sendAlert(
      alertTo,
      `🔴 DOWN: ${monitor.name}`,
      `${monitor.name} (${monitor.url}) appears DOWN on first check.\nReason: ${result.error}\n\n— Beakon`
    );
  }

  // SSL expiry warning, at most once every 24h per monitor.
  if (ssl.expiresAt) {
    const daysLeft = Math.floor((ssl.expiresAt - now()) / 86400);
    const warnedRecently = monitor.ssl_warned_at && now() - monitor.ssl_warned_at < 86400;
    if (daysLeft <= SSL_WARN_DAYS && !warnedRecently) {
      db.prepare('UPDATE monitors SET ssl_warned_at = ? WHERE id = ?').run(now(), monitor.id);
      logEvent(monitor.id, 'ssl_warning', `${daysLeft} days left`);
      await sendAlert(
        alertTo,
        `⚠️ SSL expiring in ${daysLeft}d: ${monitor.name}`,
        `The SSL certificate for ${monitor.name} (${monitor.url}) expires in ${daysLeft} day(s), on ${new Date(ssl.expiresAt * 1000).toUTCString()}.\n\n— Beakon`
      );
    }
  }
}

async function sweep() {
  // Only check monitors that belong to active (paid or trialing) accounts.
  const rows = db.prepare(`
    SELECT m.*, u.email AS u_email, u.alert_email AS u_alert_email,
           u.plan AS u_plan, u.subscription_status AS u_sub, u.trial_ends_at AS u_trial
    FROM monitors m JOIN users u ON u.id = m.user_id
    WHERE m.active = 1
  `).all();

  for (const row of rows) {
    const user = {
      email: row.u_email,
      alert_email: row.u_alert_email,
      plan: row.u_plan,
      subscription_status: row.u_sub,
      trial_ends_at: row.u_trial,
    };
    if (!isAccountActive(user)) continue;
    try {
      await checkMonitor(row, user);
    } catch (err) {
      console.error(`[monitor] check failed for #${row.id}:`, err.message);
    }
  }
}

let running = false;
export function startScheduler() {
  console.log(`[monitor] scheduler started, sweeping every ${INTERVAL_MS / 1000}s`);
  const tick = async () => {
    if (running) return; // avoid overlapping sweeps
    running = true;
    try {
      await sweep();
    } finally {
      running = false;
    }
  };
  tick(); // run once at boot
  setInterval(tick, INTERVAL_MS);
}
