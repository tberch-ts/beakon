// src/monitor.js
// The checking loop.
//
// Two engines feed engine.js:
//   1. Uptime Kuma (when KUMA_URL is set): Kuma runs the checks and pushes
//      heartbeats over its socket; we mirror monitors into it and reconcile
//      periodically. Anything Kuma can check (HTTP, keyword, ping, TCP, DNS)
//      is available.
//   2. The built-in sweeper: HTTP + SSL checks from this process, for monitors
//      that have no Kuma twin (Kuma off, or not yet synced).
import { db } from './db.js';
import { httpCheck, sslCheck } from './checks.js';
import { applyObservation, applyKumaHeartbeat, applyKumaCertInfo } from './engine.js';
import { kuma, isKumaEnabled } from './kuma.js';
import { desiredActive, reconcileKuma } from './monitors.js';

const INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10) * 1000;
const RECONCILE_EVERY_TICKS = 5;

async function checkBuiltin(m) {
  const result = await httpCheck(m.url, { keyword: m.type === 'keyword' ? m.keyword : null });
  const ssl = await sslCheck(m.url);
  await applyObservation(m.id, {
    up: result.up, responseMs: result.responseMs, error: result.error, sslExpiresAt: ssl.expiresAt, via: 'builtin',
  });
}

async function sweep() {
  const rows = db.prepare(`
    SELECT m.*, u.plan AS u_plan, u.subscription_status AS u_sub, u.trial_ends_at AS u_trial
    FROM monitors m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.active = 1
  `).all();
  const kumaLive = isKumaEnabled() && kuma?.isReady();
  let checked = 0;
  for (const row of rows) {
    // Kuma owns anything it has a twin for; the sweeper covers the rest.
    if (kumaLive && row.kuma_monitor_id) continue;
    if (row.type !== 'http' && row.type !== 'keyword') continue; // Kuma-only types
    const owner = row.user_id ? { plan: row.u_plan, subscription_status: row.u_sub, trial_ends_at: row.u_trial } : null;
    if (!desiredActive(row, owner)) continue;
    try {
      await checkBuiltin(row);
      checked++;
    } catch (err) {
      console.error(`[monitor] check failed for #${row.id}:`, err.message);
    }
  }
  return checked;
}

let running = false;
let ticks = 0;

export function startScheduler() {
  if (isKumaEnabled() && kuma) {
    kuma.on('heartbeat', (beat) => applyKumaHeartbeat(beat).catch((err) => console.error('[kuma] heartbeat handling failed:', err.message)));
    kuma.on('certInfo', (ci) => applyKumaCertInfo(ci).catch((err) => console.error('[kuma] certInfo handling failed:', err.message)));
    kuma.on('ready', () => {
      reconcileKuma()
        .then(({ synced, unlinked }) => console.log(`[kuma] reconciled: ${synced} synced, ${unlinked.length} unlinked in Kuma`))
        .catch((err) => console.error('[kuma] reconcile failed:', err.message));
    });
    kuma.connect();
    console.log(`[monitor] Uptime Kuma engine enabled (${process.env.KUMA_URL})`);
  }

  console.log(`[monitor] built-in sweeper started, every ${INTERVAL_MS / 1000}s`);
  const tick = async () => {
    if (running) return; // avoid overlapping sweeps
    running = true;
    try {
      await sweep();
      ticks++;
      if (kuma?.isReady() && ticks % RECONCILE_EVERY_TICKS === 0) {
        await reconcileKuma().catch((err) => console.error('[kuma] reconcile failed:', err.message));
      }
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, INTERVAL_MS);
}
