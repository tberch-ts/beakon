// functions/monitor.js
// The scheduled sweep: check every active monitor, record transitions, alert.
import { httpCheck, sslCheck } from './checks.js';
import { sendAlert } from './mailer.js';
import { isAccountActive, nowSec } from './plans.js';

const SSL_WARN_DAYS = parseInt(process.env.SSL_WARN_DAYS || '14', 10);

export async function runSweep(db) {
  const snap = await db.collection('monitors').where('active', '==', true).get();
  if (snap.empty) return { checked: 0 };

  // Cache user docs so we don't re-read the same user repeatedly.
  const userCache = new Map();
  async function getUser(uid) {
    if (userCache.has(uid)) return userCache.get(uid);
    const u = await db.collection('users').doc(uid).get();
    const data = u.exists ? u.data() : null;
    userCache.set(uid, data);
    return data;
  }

  let checked = 0;
  for (const doc of snap.docs) {
    const m = { id: doc.id, ...doc.data() };
    const user = await getUser(m.uid);
    if (!user || !isAccountActive(user)) continue;
    try {
      await checkOne(db, m, user);
      checked++;
    } catch (err) {
      console.error(`[monitor] check failed for ${m.id}:`, err.message);
    }
  }
  return { checked };
}

async function logEvent(db, m, kind, detail) {
  await db.collection('events').add({
    monitorId: m.id, uid: m.uid, kind, detail: detail || null, createdAt: nowSec(),
  });
}

async function checkOne(db, m, user) {
  const result = await httpCheck(m.url);
  const ssl = await sslCheck(m.url);
  const status = result.up ? 'up' : 'down';
  const prev = m.lastStatus || null;
  const alertTo = user.alertEmail || user.email;

  const update = {
    lastStatus: status,
    lastCheckedAt: nowSec(),
    lastResponseMs: result.responseMs,
    lastError: result.error || null,
  };
  if (ssl.expiresAt) update.sslExpiresAt = ssl.expiresAt;

  // Status-transition alerts.
  if (prev && prev !== status) {
    if (status === 'down') {
      await logEvent(db, m, 'down', result.error);
      await sendAlert(alertTo, `🔴 DOWN: ${m.name}`,
        `${m.name} (${m.url}) is DOWN.\nReason: ${result.error}\nDetected: ${new Date().toUTCString()}\n\n— Beakon`);
    } else {
      await logEvent(db, m, 'up', `recovered in ${result.responseMs}ms`);
      await sendAlert(alertTo, `🟢 RECOVERED: ${m.name}`,
        `${m.name} (${m.url}) is back UP.\nResponse: ${result.responseMs}ms\nRecovered: ${new Date().toUTCString()}\n\n— Beakon`);
    }
  } else if (!prev && status === 'down') {
    await logEvent(db, m, 'down', result.error);
    await sendAlert(alertTo, `🔴 DOWN: ${m.name}`,
      `${m.name} (${m.url}) appears DOWN on first check.\nReason: ${result.error}\n\n— Beakon`);
  }

  // SSL expiry warning, at most once per 24h.
  if (ssl.expiresAt) {
    const daysLeft = Math.floor((ssl.expiresAt - nowSec()) / 86400);
    const warnedRecently = m.sslWarnedAt && nowSec() - m.sslWarnedAt < 86400;
    if (daysLeft <= SSL_WARN_DAYS && !warnedRecently) {
      update.sslWarnedAt = nowSec();
      await logEvent(db, m, 'ssl_warning', `${daysLeft} days left`);
      await sendAlert(alertTo, `⚠️ SSL expiring in ${daysLeft}d: ${m.name}`,
        `The SSL certificate for ${m.name} (${m.url}) expires in ${daysLeft} day(s), on ${new Date(ssl.expiresAt * 1000).toUTCString()}.\n\n— Beakon`);
    }
  }

  await db.collection('monitors').doc(m.id).update(update);
}
