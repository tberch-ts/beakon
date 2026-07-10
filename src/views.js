// src/views.js
// Minimal server-rendered HTML. No template engine dependency — just functions.
import { PLANS, monitorLimit, trialDaysLeft, isAccountActive } from './plans.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function layout(title, body, opts = {}) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Beakon</title>
<style>
  :root { --bg:#0b1220; --card:#121b2e; --line:#22304d; --text:#e8eefc; --muted:#90a0c0; --accent:#3b82f6; --green:#22c55e; --red:#ef4444; --amber:#f59e0b; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
  a { color:var(--accent); text-decoration:none; }
  .wrap { max-width:920px; margin:0 auto; padding:24px 18px 60px; }
  header.top { display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--line); }
  .brand { font-weight:800; letter-spacing:-.3px; font-size:18px; }
  .brand span { color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:14px 0; }
  h1 { font-size:22px; margin:6px 0 2px; }
  h2 { font-size:16px; margin:0 0 12px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:#0d1626; color:var(--text); }
  button, .btn { display:inline-block; cursor:pointer; border:0; border-radius:8px; padding:10px 16px; font-weight:600; background:var(--accent); color:#fff; }
  .btn.secondary { background:transparent; border:1px solid var(--line); color:var(--text); }
  .btn.danger { background:transparent; border:1px solid var(--red); color:#fca5a5; padding:6px 10px; font-size:13px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); font-size:14px; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; }
  .pill.up { background:rgba(34,197,94,.15); color:#86efac; }
  .pill.down { background:rgba(239,68,68,.15); color:#fca5a5; }
  .pill.unknown { background:rgba(144,160,192,.15); color:var(--muted); }
  .muted { color:var(--muted); }
  .banner { padding:12px 14px; border-radius:10px; margin:8px 0 0; font-size:14px; }
  .banner.warn { background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.4); color:#fcd34d; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
  .row > div { flex:1; min-width:180px; }
  .err { color:#fca5a5; font-size:14px; margin:8px 0; }
  nav a { margin-left:16px; }
</style>
</head><body>
<header class="top">
  <div class="brand">Bea<span>kon</span></div>
  <nav>${opts.nav || ''}</nav>
</header>
<div class="wrap">${body}</div>
</body></html>`;
}

export function loginPage(error) {
  return layout('Sign in', `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h1>Sign in</h1>
      <p class="muted">Welcome back.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form method="post" action="/login">
        <label>Email</label><input name="email" type="email" required>
        <label>Password</label><input name="password" type="password" required>
        <div style="margin-top:16px;"><button type="submit">Sign in</button></div>
      </form>
      <p class="muted" style="margin-top:14px;">No account? <a href="/signup">Start your free trial</a></p>
    </div>`);
}

export function signupPage(error) {
  return layout('Start free trial', `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h1>Start your free trial</h1>
      <p class="muted">${esc(process.env.TRIAL_DAYS || '14')} days free. No card required.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form method="post" action="/signup">
        <label>Email</label><input name="email" type="email" required>
        <label>Password</label><input name="password" type="password" minlength="8" required>
        <div style="margin-top:16px;"><button type="submit">Create account</button></div>
      </form>
      <p class="muted" style="margin-top:14px;">Already have an account? <a href="/login">Sign in</a></p>
    </div>`);
}

function statusPill(status) {
  if (status === 'up') return `<span class="pill up">UP</span>`;
  if (status === 'down') return `<span class="pill down">DOWN</span>`;
  return `<span class="pill unknown">—</span>`;
}

function fmtTime(epoch) {
  if (!epoch) return '<span class="muted">never</span>';
  const d = new Date(epoch * 1000);
  return `<span class="muted">${d.toLocaleString()}</span>`;
}

function fmtSsl(epoch) {
  if (!epoch) return '<span class="muted">—</span>';
  const days = Math.floor((epoch - Date.now() / 1000) / 86400);
  const cls = days <= 14 ? 'down' : 'up';
  return `<span class="pill ${cls}">${days}d</span>`;
}

export function dashboard(user, monitors) {
  const nav = `<a href="/billing">Billing</a><a href="/logout">Sign out</a>`;
  const limit = monitorLimit(user);
  const atLimit = monitors.length >= limit;

  let banner = '';
  if (user.subscription_status === 'trialing') {
    const left = trialDaysLeft(user);
    banner = `<div class="banner warn">Free trial — ${left} day(s) left. <a href="/billing">Upgrade to keep monitoring →</a></div>`;
  } else if (!isAccountActive(user)) {
    banner = `<div class="banner warn">Your account is inactive. Monitoring is paused. <a href="/billing">Reactivate →</a></div>`;
  }

  const rows = monitors.map((m) => `
    <tr>
      <td><strong>${esc(m.name)}</strong><br><span class="muted">${esc(m.url)}</span></td>
      <td>${statusPill(m.last_status)}${m.last_error ? `<br><span class="muted" style="font-size:12px">${esc(m.last_error)}</span>` : ''}</td>
      <td>${m.last_response_ms != null ? m.last_response_ms + ' ms' : '<span class="muted">—</span>'}</td>
      <td>${fmtSsl(m.ssl_expires_at)}</td>
      <td>${fmtTime(m.last_checked_at)}</td>
      <td><form method="post" action="/app/monitors/${m.id}/delete" onsubmit="return confirm('Delete this monitor?')"><button class="btn danger">Delete</button></form></td>
    </tr>`).join('');

  return layout('Dashboard', `
    ${banner}
    <h1>Monitors</h1>
    <p class="muted">${monitors.length} of ${limit} used · plan: ${esc(PLANS[user.plan]?.label || user.plan)}</p>

    <div class="card">
      <h2>Add a monitor</h2>
      ${atLimit ? `<div class="err">You've hit your plan limit (${limit}). <a href="/billing">Upgrade →</a></div>` : `
      <form method="post" action="/app/monitors">
        <div class="row">
          <div><label>Name</label><input name="name" placeholder="Client homepage" required></div>
          <div><label>URL</label><input name="url" placeholder="example.com" required></div>
          <div style="flex:0 0 auto;"><label>&nbsp;</label><button type="submit">Add</button></div>
        </div>
      </form>`}
    </div>

    <div class="card">
      ${monitors.length === 0
        ? `<p class="muted">No monitors yet. Add your first site above — Beakon checks it every minute and emails you the moment it goes down or the SSL is about to expire.</p>`
        : `<table>
            <thead><tr><th>Site</th><th>Status</th><th>Response</th><th>SSL</th><th>Last check</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>

    <div class="card">
      <h2>Alert settings</h2>
      <form method="post" action="/app/settings" class="row">
        <div><label>Send alerts to</label><input name="alert_email" type="email" value="${esc(user.alert_email || user.email)}"></div>
        <div style="flex:0 0 auto;"><label>&nbsp;</label><button type="submit">Save</button></div>
      </form>
    </div>
  `, { nav });
}

export function billingPage(user) {
  const nav = `<a href="/app">Dashboard</a><a href="/logout">Sign out</a>`;
  const active = user.subscription_status === 'active';
  const plans = ['starter', 'agency'].map((key) => {
    const p = PLANS[key];
    const current = user.plan === key && active;
    return `<div class="card">
      <h2>${esc(p.label)} — ${esc(p.priceLabel)}</h2>
      <p class="muted">Up to ${p.limit} monitors, 1-minute checks, email + SSL alerts.</p>
      ${current
        ? `<span class="pill up">Current plan</span>`
        : `<form method="post" action="/billing/checkout"><input type="hidden" name="plan" value="${key}"><button ${p.priceId ? '' : 'disabled'} type="submit">${active ? 'Switch to ' + p.label : 'Subscribe'}</button></form>
           ${p.priceId ? '' : '<p class="err">Price not configured yet (set STRIPE_PRICE_* env vars).</p>'}`}
    </div>`;
  }).join('');

  return layout('Billing', `
    <h1>Billing</h1>
    <p class="muted">Status: <strong>${esc(user.subscription_status)}</strong>${user.subscription_status === 'trialing' ? ` · ${trialDaysLeft(user)} trial day(s) left` : ''}</p>
    ${plans}
    ${active ? `<form method="post" action="/billing/portal"><button class="btn secondary">Manage / cancel subscription</button></form>` : ''}
  `, { nav });
}
