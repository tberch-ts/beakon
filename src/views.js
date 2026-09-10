// src/views.js
// Minimal server-rendered HTML. No template engine dependency — just functions.
import { PLANS, trialDaysLeft, isAccountActive } from './plans.js';
import { effectiveAlertMode } from './clients.js';
import { RUNGS, CHECKS, ATTESTATIONS, MAX_RUNG } from './searchLadder.js';

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
  .wrap { max-width:${opts.wide ? '1180px' : '920px'}; margin:0 auto; padding:24px 18px 60px; }
  header.top { display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--line); }
  .brand { font-weight:800; letter-spacing:-.3px; font-size:18px; }
  .brand span { color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:14px 0; }
  h1 { font-size:22px; margin:6px 0 2px; }
  h2 { font-size:16px; margin:0 0 12px; }
  h3 { font-size:14px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  input, select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:#0d1626; color:var(--text); font:inherit; }
  input[type=checkbox] { width:auto; margin-right:6px; }
  button, .btn { display:inline-block; cursor:pointer; border:0; border-radius:8px; padding:10px 16px; font-weight:600; background:var(--accent); color:#fff; font:inherit; font-weight:600; }
  .btn.secondary, button.secondary { background:transparent; border:1px solid var(--line); color:var(--text); }
  .btn.danger, button.danger { background:transparent; border:1px solid var(--red); color:#fca5a5; padding:6px 10px; font-size:13px; }
  .btn.small, button.small { padding:6px 10px; font-size:13px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); font-size:14px; vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; white-space:nowrap; }
  .pill.up { background:rgba(34,197,94,.15); color:#86efac; }
  .pill.down { background:rgba(239,68,68,.15); color:#fca5a5; }
  .pill.unknown, .pill.off { background:rgba(144,160,192,.15); color:var(--muted); }
  .pill.warn { background:rgba(245,158,11,.15); color:#fcd34d; }
  .pill.info { background:rgba(59,130,246,.15); color:#93c5fd; }
  .muted { color:var(--muted); }
  .small { font-size:12px; }
  .banner { padding:12px 14px; border-radius:10px; margin:8px 0 0; font-size:14px; }
  .banner.warn { background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.4); color:#fcd34d; }
  .banner.ok { background:rgba(34,197,94,.12); border:1px solid rgba(34,197,94,.4); color:#86efac; }
  .banner.err { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.4); color:#fca5a5; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
  .row > div { flex:1; min-width:160px; }
  .row > div.auto { flex:0 0 auto; min-width:0; }
  .inline { display:inline; }
  .err { color:#fca5a5; font-size:14px; margin:8px 0; }
  nav a { margin-left:16px; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; }
  .stat { flex:1; min-width:140px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:22px; }
  .stat span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  details.client { border:1px solid var(--line); border-radius:12px; margin:12px 0; background:var(--card); }
  details.client > summary { cursor:pointer; padding:14px 18px; font-weight:700; list-style:none; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  details.client > summary::-webkit-details-marker { display:none; }
  details.client > div { padding:0 18px 18px; border-top:1px solid var(--line); }
  .tabs a { margin-right:12px; padding:6px 10px; border-radius:8px; border:1px solid var(--line); }
  .tabs a.on { background:var(--accent); color:#fff; border-color:var(--accent); }
  .gbtn { display:inline-flex; align-items:center; gap:10px; width:100%; justify-content:center; background:#fff; color:#111; border-radius:8px; padding:11px 16px; font-weight:600; border:0; cursor:pointer; }
  .hide { display:none; }
  code { background:#0d1626; padding:2px 6px; border-radius:6px; font-size:13px; }
  .grade { display:inline-flex; align-items:baseline; gap:4px; font-weight:800; font-size:34px; line-height:1; }
  .grade small { font-size:14px; color:var(--muted); font-weight:600; }
  .ladder { display:grid; grid-template-columns:repeat(10, 1fr); gap:4px; margin:10px 0; }
  .ladder span { height:10px; border-radius:3px; background:rgba(144,160,192,.2); }
  .ladder span.on { background:var(--green); }
  .ladder span.next { background:var(--amber); }
  .rung { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:8px 0; }
  .rung.cleared { border-color:rgba(34,197,94,.4); }
  .rung.next { border-color:rgba(245,158,11,.6); background:rgba(245,158,11,.06); }
  .rung h4 { margin:0 0 4px; font-size:15px; display:flex; gap:10px; align-items:center; }
  .item { display:flex; gap:10px; align-items:flex-start; padding:6px 0; border-top:1px solid var(--line); font-size:14px; }
  .item .mark { flex:0 0 22px; font-weight:800; }
  .item .mark.ok { color:#86efac; } .item .mark.no { color:#fca5a5; } .item .mark.todo { color:#fcd34d; }
  .item label { display:flex; gap:8px; align-items:flex-start; margin:0; color:var(--text); font-size:14px; cursor:pointer; }
  .item .fix { color:var(--muted); font-size:13px; margin-top:2px; }
</style>
</head><body>
<header class="top">
  <div class="brand"><a href="/" style="color:inherit">Bea<span>kon</span></a></div>
  <nav>${opts.nav || ''}</nav>
</header>
<div class="wrap">${body}</div>
${opts.script || ''}
</body></html>`;
}

const flashHtml = (f) => (f ? `<div class="banner ${esc(f.kind || 'ok')}">${esc(f.msg)}</div>` : '');

// ---------- Auth ----------
export function loginPage({ error, firebaseConfig, legacy }) {
  const google = firebaseConfig ? `
    <button class="gbtn" id="google">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.6-2 15.4-5.6l-7.5-5.8c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.7-4.1-13.6-9.8l-7.8 6C6.5 42.6 14.6 48 24 48z"/></svg>
      Continue with Google
    </button>
    <div class="err hide" id="gerr"></div>` : '';
  const legacyForm = legacy ? `
    ${firebaseConfig ? '<p class="muted small" style="margin:18px 0 0;text-align:center">or sign in with a password</p>' : ''}
    <form method="post" action="/login">
      <label>Email</label><input name="email" type="email" required>
      <label>Password</label><input name="password" type="password" required>
      <div style="margin-top:16px;"><button type="submit" class="${firebaseConfig ? 'secondary' : ''}">Sign in</button></div>
    </form>
    <p class="muted" style="margin-top:14px;">No account? <a href="/signup">Start your free trial</a></p>` : '';
  const script = firebaseConfig ? `
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
const auth = getAuth(initializeApp(${JSON.stringify(firebaseConfig)}));
const btn = document.getElementById('google'); const err = document.getElementById('gerr');
btn.onclick = async () => {
  err.classList.add('hide'); btn.disabled = true;
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    const idToken = await cred.user.getIdToken();
    const res = await fetch('/auth/firebase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Sign-in failed');
    location.href = data.redirect || '/app';
  } catch (e) { err.textContent = e.message.replace('Firebase: ', ''); err.classList.remove('hide'); btn.disabled = false; }
};
</script>` : '';
  return layout('Sign in', `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h1>Sign in</h1>
      <p class="muted">${firebaseConfig ? 'Use the Google account your sites are registered to.' : 'Welcome back.'}</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      ${google}
      ${legacyForm}
      ${!google && !legacy ? '<p class="err">Sign-in is not configured. Set the FIREBASE_* variables.</p>' : ''}
    </div>`, { script });
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

export function verifyPage(ok, client) {
  return layout('Alert email', `
    <div class="card" style="max-width:480px;margin:40px auto;">
      ${ok
        ? `<h1>✓ Confirmed</h1><p>Alerts for <strong>${esc(client.name)}</strong> will now be sent to <strong>${esc(client.alert_email)}</strong>.</p>`
        : `<h1>Link expired</h1><p class="muted">That confirmation link is invalid or has expired. Sign in and press "Resend" under alert settings to get a new one.</p>`}
      <p><a href="/app">Go to dashboard →</a></p>
    </div>`);
}

// ---------- Shared bits ----------
function statusPill(m) {
  if (!m.active) return `<span class="pill off">PAUSED</span>`;
  if (m.last_status === 'up') return `<span class="pill up">UP</span>`;
  if (m.last_status === 'down') return `<span class="pill down">DOWN</span>`;
  return `<span class="pill unknown">PENDING</span>`;
}
function fmtTime(epoch) {
  if (!epoch) return '<span class="muted">never</span>';
  return `<span class="muted">${new Date(epoch * 1000).toLocaleString()}</span>`;
}
function fmtSsl(epoch) {
  if (!epoch) return '<span class="muted">—</span>';
  const days = Math.floor((epoch - Date.now() / 1000) / 86400);
  const cls = days < 0 ? 'down' : days <= 14 ? 'warn' : 'up';
  return `<span class="pill ${cls}">${days}d</span>`;
}
function target(m) {
  if (m.type === 'http' || m.type === 'keyword') return m.url;
  return m.port ? `${m.hostname}:${m.port}` : m.hostname;
}
const typeLabel = { http: 'HTTP', keyword: 'Keyword', ping: 'Ping', port: 'TCP', dns: 'DNS' };

function alertStatusLine(client, mailConfigured) {
  const mode = effectiveAlertMode(client);
  if (mode === 'none') return `<span class="pill off">ALERTS OFF</span> <span class="muted small">${client.alert_email ? 'switched off' : 'no address set — nothing will be sent'}</span>`;
  if (mode === 'email_unverified') return `<span class="pill warn">UNCONFIRMED</span> <span class="muted small">check ${esc(client.alert_email)} for a confirmation link — nothing is sent until then${mailConfigured ? '' : ' (SMTP is not configured on the server, so no mail went out)'}</span>`;
  if (mode === 'kuma') return `<span class="pill info">UPTIME KUMA</span> <span class="muted small">channel ${esc(client.alert_channel)}</span>`;
  return `<span class="pill up">EMAIL ✓</span> <span class="muted small">${esc(client.alert_email)} confirmed</span>`;
}

function alertForm(client, { action, back, isAdmin, kumaChannels, mailConfigured }) {
  const ch = client.alert_channel || 'email';
  const kumaOpts = (kumaChannels || []).map((n) => `<option value="kuma:${n.id}" ${ch === `kuma:${n.id}` ? 'selected' : ''}>Uptime Kuma: ${esc(n.name)} (${esc(n.type)})</option>`).join('');
  return `
    <p>${alertStatusLine(client, mailConfigured)}</p>
    <form method="post" action="${action}">
      <input type="hidden" name="back" value="${esc(back)}">
      <div class="row">
        <div class="auto"><label>&nbsp;</label><label style="margin:0;color:var(--text)"><input type="checkbox" name="alerts_enabled" value="1" ${client.alerts_enabled ? 'checked' : ''}> Alerts on</label></div>
        <div><label>Alert type</label>
          <select name="alert_channel">
            <option value="none" ${ch === 'none' ? 'selected' : ''}>Disabled</option>
            <option value="email" ${ch === 'email' ? 'selected' : ''}>Email (down / recovered / SSL expiry)</option>
            ${kumaOpts}
          </select></div>
        <div><label>Alert email${client.alert_email && !client.alert_email_verified_at ? ' (unconfirmed)' : ''}</label>
          <input name="alert_email" type="email" value="${esc(client.alert_email || '')}" placeholder="leave blank to turn email alerts off"></div>
        ${isAdmin ? `<div class="auto"><label>&nbsp;</label><label style="margin:0;color:var(--text)"><input type="checkbox" name="mark_verified" value="1"> Mark verified</label></div>` : ''}
        <div class="auto"><label>&nbsp;</label><button type="submit">Save</button></div>
      </div>
    </form>
    ${client.alert_email && !client.alert_email_verified_at ? `<form method="post" action="${action}/resend" class="inline" style="margin-top:8px;display:block"><input type="hidden" name="back" value="${esc(back)}"><button class="secondary small">Resend confirmation email</button></form>` : ''}`;
}

function addMonitorForm({ action, monitorTypes, clientId, clients, idSuffix = '' }) {
  const opts = monitorTypes.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('');
  const clientSel = clients
    ? `<div><label>Client</label><select name="client_id">${clients.map((c) => `<option value="${c.id}" ${c.id === clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`
    : `<input type="hidden" name="client_id" value="${clientId}">`;
  return `
    <form method="post" action="${action}" data-addmon>
      <div class="row">
        ${clientSel}
        <div><label>Name</label><input name="name" placeholder="Client homepage"></div>
        <div><label>Type</label><select name="type" data-type>${opts}</select></div>
        <div data-f="url"><label>URL</label><input name="url" placeholder="example.com"></div>
        <div data-f="keyword" class="hide"><label>Keyword (must appear in page)</label><input name="keyword" placeholder="Welcome"></div>
        <div data-f="hostname" class="hide"><label>Hostname</label><input name="hostname" placeholder="example.com"></div>
        <div data-f="port" class="hide"><label>Port</label><input name="port" type="number" placeholder="443"></div>
        <div class="auto"><label>&nbsp;</label><button type="submit">Add</button></div>
      </div>
    </form>`;
}

const addMonitorScript = `
<script>
document.querySelectorAll('[data-addmon]').forEach((form) => {
  const sel = form.querySelector('[data-type]');
  const show = { http: ['url'], keyword: ['url','keyword'], ping: ['hostname'], port: ['hostname','port'], dns: ['hostname'] };
  const apply = () => { const on = show[sel.value] || ['url']; form.querySelectorAll('[data-f]').forEach((d) => d.classList.toggle('hide', !on.includes(d.dataset.f))); };
  sel.addEventListener('change', apply); apply();
});
</script>`;

function eventsTable(events, { showClient = false } = {}) {
  if (!events.length) return '<p class="muted">No events yet.</p>';
  const cls = { down: 'down', up: 'up', ssl_warning: 'warn', ssl_expired: 'down', alert_email: 'info', alert_kuma: 'info', down_4h: 'down' };
  return `<table><thead><tr><th>When</th>${showClient ? '<th>Client</th>' : ''}<th>Monitor</th><th>Event</th><th>Detail</th></tr></thead><tbody>
    ${events.map((e) => `<tr><td>${fmtTime(e.created_at)}</td>${showClient ? `<td>${esc(e.client_name || '—')}</td>` : ''}<td>${esc(e.monitor_name)}</td><td><span class="pill ${cls[e.kind] || 'unknown'}">${esc(e.kind)}</span></td><td class="muted small">${esc(e.detail || '')}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- Customer dashboard ----------
export function dashboard({ user, isAdmin, clients, client, monitors, monitorTypes, used, limit, events, kumaChannels, flash, mailConfigured }) {
  const nav = `${isAdmin ? '<a href="/admin">Admin</a>' : ''}<a href="/billing">Billing</a><a href="/logout">Sign out</a>`;
  const atLimit = used >= limit;

  let banner = '';
  if (!isAdmin && user.subscription_status === 'trialing') {
    banner = `<div class="banner warn">Free trial — ${trialDaysLeft(user)} day(s) left. <a href="/billing">Upgrade to keep your own monitors running →</a></div>`;
  } else if (!isAdmin && !isAccountActive(user)) {
    banner = `<div class="banner warn">Your account is inactive — monitors you added are paused. Monitors set up by your provider keep running. <a href="/billing">Reactivate →</a></div>`;
  }

  const switcher = clients.length > 1 ? `<p class="tabs">${clients.map((c) => `<a class="${client && c.id === client.id ? 'on' : ''}" href="/app?client=${c.id}">${esc(c.name)}</a>`).join('')}</p>` : '';

  if (!client) {
    return layout('Dashboard', `${flashHtml(flash)}<h1>Monitors</h1><div class="card"><p class="muted">No clients yet. ${isAdmin ? '<a href="/admin">Create one in the admin console →</a>' : ''}</p></div>`, { nav });
  }

  const back = `/app?client=${client.id}`;
  const rows = monitors.map((m) => `
    <tr>
      <td><strong>${esc(m.name)}</strong> <span class="pill info">${typeLabel[m.type] || m.type}</span>${m.source !== 'user' ? ' <span class="pill unknown" title="Set up by your provider — not billed to you">INCLUDED</span>' : ''}<br><span class="muted small">${esc(target(m))}</span></td>
      <td>${statusPill(m)}${m.last_error && m.last_status === 'down' ? `<br><span class="muted small">${esc(m.last_error)}</span>` : ''}</td>
      <td>${m.last_response_ms != null ? m.last_response_ms + ' ms' : '<span class="muted">—</span>'}</td>
      <td>${fmtSsl(m.ssl_expires_at)}</td>
      <td>${fmtTime(m.last_checked_at)}</td>
      <td style="white-space:nowrap">
        <form method="post" action="/app/monitors/${m.id}/toggle" class="inline"><input type="hidden" name="back" value="${esc(back)}"><button class="secondary small">${m.active ? 'Disable' : 'Enable'}</button></form>
        ${m.source === 'user' || isAdmin ? `<form method="post" action="/app/monitors/${m.id}/delete" class="inline" onsubmit="return confirm('Delete this monitor?')"><input type="hidden" name="back" value="${esc(back)}"><button class="danger">Delete</button></form>` : ''}
      </td>
    </tr>`).join('');

  return layout('Dashboard', `
    ${banner}
    ${flashHtml(flash)}
    ${switcher}
    <h1>${esc(client.name)}</h1>
    <p class="muted">${monitors.length} monitor(s) · ${monitors.filter((m) => m.active && m.last_status === 'down').length} down · ${isAdmin ? 'admin' : `your plan: ${esc(PLANS[user.plan]?.label || user.plan)}, ${used} of ${limit} paid monitors used`}</p>

    <div class="card">
      ${monitors.length === 0
        ? `<p class="muted">No monitors yet. Add a site below — Beakon checks it every minute and tells you the moment it goes down or the SSL certificate is about to expire.</p>`
        : `<table>
            <thead><tr><th>Site</th><th>Status</th><th>Response</th><th>SSL</th><th>Last check</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>

    <div class="card">
      <h2>Add a monitor</h2>
      ${!isAdmin && atLimit ? `<div class="err">You've hit your plan limit (${limit}). <a href="/billing">Upgrade →</a></div>` : addMonitorForm({ action: '/app/monitors', monitorTypes, clientId: client.id })}
    </div>

    <div class="card">
      <h2>Alerts</h2>
      ${alertForm(client, { action: `/app/clients/${client.id}/alerts`, back, isAdmin, kumaChannels, mailConfigured })}
    </div>

    <div class="card">
      <h2>Recent activity</h2>
      ${eventsTable(events)}
    </div>
  `, { nav, script: addMonitorScript });
}

// ---------- Admin console ----------
export function adminPage({ user, clients, orphanMonitors, monitorTypes, kuma, integrations, events, flash }) {
  const nav = `<a href="/app">Dashboard</a><a href="/logout">Sign out</a>`;
  const allMonitors = clients.flatMap((c) => c.monitors).concat(orphanMonitors);
  const downCount = allMonitors.filter((m) => m.active && m.last_status === 'down').length;
  const clientOptions = (selected) => clients.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  const kumaPill = !kuma.enabled ? '<span class="pill off">DISABLED</span>' : kuma.connected ? '<span class="pill up">CONNECTED</span>' : `<span class="pill down">DISCONNECTED</span>`;
  const onoff = (v) => (v ? '<span class="pill up">ON</span>' : '<span class="pill off">OFF</span>');

  const monitorRows = (ms) => ms.length === 0 ? '<p class="muted">No monitors.</p>' : `
    <table><thead><tr><th>Site</th><th>Status</th><th>Resp</th><th>SSL</th><th>Last check</th><th>Source</th><th>Kuma</th><th></th></tr></thead><tbody>
    ${ms.map((m) => `<tr>
      <td><strong>${esc(m.name)}</strong> <span class="pill info">${typeLabel[m.type] || m.type}</span><br><span class="muted small">${esc(target(m))}</span></td>
      <td>${statusPill(m)}${m.last_error && m.last_status === 'down' ? `<br><span class="muted small">${esc(m.last_error)}</span>` : ''}</td>
      <td>${m.last_response_ms != null ? m.last_response_ms + ' ms' : '—'}</td>
      <td>${fmtSsl(m.ssl_expires_at)}</td>
      <td>${fmtTime(m.last_checked_at)}</td>
      <td><span class="pill ${m.billable ? 'warn' : 'unknown'}" title="${m.billable ? 'counts against the owner\'s plan' : 'free to the client'}">${esc(m.source)}${m.billable ? ' · billed' : ' · free'}</span>${m.owner_email ? `<br><span class="muted small">${esc(m.owner_email)}</span>` : ''}</td>
      <td class="small">${m.kuma_monitor_id ? `<span class="pill up">#${m.kuma_monitor_id}</span>` : kuma.enabled ? '<span class="pill warn">unsynced</span>' : '<span class="muted">built-in</span>'}</td>
      <td style="white-space:nowrap">
        <form method="post" action="/app/monitors/${m.id}/toggle" class="inline"><input type="hidden" name="back" value="/admin"><button class="secondary small">${m.active ? 'Disable' : 'Enable'}</button></form>
        <form method="post" action="/admin/monitors/${m.id}/billable" class="inline"><button class="secondary small" title="Toggle whether this counts against the owner's plan">${m.billable ? 'Make free' : 'Make billed'}</button></form>
        <form method="post" action="/admin/monitors/${m.id}/assign" class="inline"><select name="client_id" onchange="this.form.submit()" style="width:auto;padding:5px 8px;font-size:13px"><option value="">Move to…</option>${clientOptions(-1)}</select></form>
        <form method="post" action="/app/monitors/${m.id}/delete" class="inline" onsubmit="return confirm('Delete this monitor?')"><input type="hidden" name="back" value="/admin"><button class="danger">Delete</button></form>
      </td>
    </tr>`).join('')}
    </tbody></table>`;

  const clientCards = clients.map((c) => `
    <details class="client" ${c.down_count > 0 ? 'open' : ''}>
      <summary>
        <span>${esc(c.name)}</span>
        <span class="muted small">${esc(c.slug)}${c.domain ? ' · ' + esc(c.domain) : ''} · ${esc(c.source)}${c.crm_client_id ? ' · CRM #' + c.crm_client_id : ''}</span>
        <span class="pill ${c.down_count > 0 ? 'down' : c.monitors.length ? 'up' : 'unknown'}">${c.down_count > 0 ? c.down_count + ' DOWN' : c.monitors.length ? 'ALL UP' : 'NO MONITORS'}</span>
        ${gradePill(c.search)}
        <span class="muted small">${c.monitors.length} monitor(s) · ${c.users.length} user(s)</span>
        <span style="margin-left:auto">${alertStatusLine(c, integrations.mail)}</span>
      </summary>
      <div>
        <h3>Monitors</h3>
        ${monitorRows(c.monitors)}
        <h3>Add monitor (free to client)</h3>
        ${addMonitorForm({ action: '/admin/monitors', monitorTypes, clientId: c.id })}
        <h3>Search ladder</h3>
        ${searchSummaryHtml(c)}
        <h3>Alerts</h3>
        ${alertForm(c, { action: `/app/clients/${c.id}/alerts`, back: '/admin', isAdmin: true, kumaChannels: kuma.channels, mailConfigured: integrations.mail })}
        <h3>Who can sign in</h3>
        ${c.users.length ? `<p>${c.users.map((u) => `<span class="pill ${u.user_id ? 'up' : 'unknown'}" title="${u.user_id ? 'has signed in' : 'invited, not yet signed in'}">${esc(u.email)}</span>
          <form method="post" action="/admin/clients/${c.id}/users/remove" class="inline"><input type="hidden" name="email" value="${esc(u.email)}"><button class="danger small" style="padding:2px 8px">×</button></form> `).join(' ')}</p>` : '<p class="muted small">Nobody yet — the client cannot see this dashboard until an email is granted.</p>'}
        <form method="post" action="/admin/clients/${c.id}/users"><div class="row"><div><label>Grant access (Google email)</label><input name="email" type="email" required placeholder="owner@example.com"></div><div class="auto"><label>&nbsp;</label><button class="secondary">Grant</button></div></div></form>
        <h3>Client</h3>
        <form method="post" action="/admin/clients/${c.id}/update"><div class="row"><div><label>Name</label><input name="name" value="${esc(c.name)}"></div><div><label>Domain</label><input name="domain" value="${esc(c.domain || '')}"></div><div class="auto"><label>&nbsp;</label><button class="secondary">Save</button></div></div></form>
        <form method="post" action="/admin/clients/${c.id}/delete" onsubmit="return confirm('Delete this client and ALL its monitors?')" style="margin-top:10px"><button class="danger">Delete client</button></form>
      </div>
    </details>`).join('');

  const unlinked = kuma.unlinked.length ? `
    <div class="card">
      <h2>In Uptime Kuma but not in Beakon (${kuma.unlinked.length})</h2>
      <p class="muted small">Monitors created directly in Kuma's UI. Import one to attach it to a client; it will be free to the client.</p>
      <table><thead><tr><th>Kuma #</th><th>Name</th><th>Type</th><th>Target</th><th></th></tr></thead><tbody>
      ${kuma.unlinked.map((k) => `<tr><td>${k.id}</td><td>${esc(k.name)}</td><td>${esc(k.type)}</td><td class="muted small">${esc(k.url || k.hostname || '')}${k.port ? ':' + k.port : ''}</td>
        <td><form method="post" action="/admin/kuma/import" class="inline"><input type="hidden" name="kuma_id" value="${k.id}"><select name="client_id" style="width:auto;padding:5px 8px;font-size:13px">${clientOptions(-1)}</select> <button class="secondary small">Import</button></form></td></tr>`).join('')}
      </tbody></table>
    </div>` : '';

  return layout('Admin', `
    ${flashHtml(flash)}
    <h1>All clients</h1>
    <p class="muted">Signed in as ${esc(user.email)} · admin</p>
    <div class="stats">
      <div class="stat"><b>${clients.length}</b><span>clients</span></div>
      <div class="stat"><b>${allMonitors.length}</b><span>monitors</span></div>
      <div class="stat"><b style="color:${downCount ? '#fca5a5' : '#86efac'}">${downCount}</b><span>down now</span></div>
      <div class="stat"><b>${kumaPill}</b><span>Uptime Kuma${kuma.url ? ' · ' + esc(kuma.url) : ''}</span>${kuma.lastError ? `<br><span class="err small">${esc(kuma.lastError)}</span>` : ''}</div>
      <div class="stat"><b>${onoff(integrations.mail)}</b><span>SMTP</span></div>
      <div class="stat"><b>${onoff(integrations.crmSignals)} ${onoff(integrations.crmWebhook)}</b><span>CRM signals · CRM onboarding</span></div>
      <div class="stat"><b>${onoff(integrations.firebase)}</b><span>Google sign-in</span></div>
    </div>

    ${clientCards || '<div class="card"><p class="muted">No clients yet.</p></div>'}

    ${orphanMonitors.length ? `<div class="card"><h2>Monitors without a client (${orphanMonitors.length})</h2>${monitorRows(orphanMonitors)}</div>` : ''}

    <div class="card">
      <h2>New client</h2>
      <form method="post" action="/admin/clients">
        <div class="row">
          <div><label>Name</label><input name="name" required placeholder="Joe's Barber"></div>
          <div><label>Slug (optional)</label><input name="slug" placeholder="joes-barber"></div>
          <div><label>Domain (optional)</label><input name="domain" placeholder="joesbarber.com"></div>
          <div><label>Owner email (optional)</label><input name="owner_email" type="email" placeholder="joe@joesbarber.com"></div>
          <div class="auto"><label>&nbsp;</label><button>Create</button></div>
        </div>
      </form>
      <p class="muted small">Clients onboarded from marketingCRM appear here automatically (source: crm).</p>
    </div>

    ${unlinked}

    <div class="card">
      <h2>Recent events</h2>
      ${eventsTable(events, { showClient: true })}
    </div>
  `, { nav, wide: true, script: addMonitorScript });
}

// ---------- Search ladder ----------
function gradePill(search) {
  if (!search) return '<span class="pill unknown">SEARCH ?/10</span>';
  const cls = search.grade >= 7 ? 'up' : search.grade >= 3 ? 'warn' : 'down';
  return `<span class="pill ${cls}" title="Search Ladder grade">SEARCH ${search.grade}/10</span>`;
}

function searchSummaryHtml(c) {
  const s = c.search;
  const analyze = `<form method="post" action="/admin/clients/${c.id}/search/analyze" class="inline"><button class="secondary small">${s ? 'Re-analyze' : 'Analyze search'}</button></form>`;
  if (!s) return `<p class="muted small">Not analyzed yet. ${c.domain || c.monitors.some((m) => m.type === 'http') ? analyze : 'Give the client a domain or an HTTP monitor first.'}</p>`;
  return `<div class="row" style="align-items:center">
    <div class="auto"><span class="grade">${s.grade}<small>/ ${MAX_RUNG}</small></span></div>
    <div><div>${s.next ? `Next phase: <strong>Rung ${s.next.rung} — ${esc(s.next.name)}</strong> <span class="muted small">(${s.next.failing.length + s.next.missing.length} item(s) to clear)</span>` : '<strong>Top of the ladder.</strong>'}</div>
      <div class="muted small">${esc(s.domain)}${s.sites.length > 1 ? ` + ${s.sites.length - 1} more site(s)` : ''} · analyzed ${new Date(s.analyzedAt * 1000).toLocaleString()}</div></div>
    <div class="auto"><a class="btn secondary small" href="/admin/clients/${c.id}/search">Open report</a> ${analyze}</div>
  </div>`;
}

/**
 * The full ladder report for one client: one tab per site, the grade, the
 * next phase as a work order, every rung with its checks, and the attestation
 * form. `report` is searchReportForCrm(); `site` is the selected site.
 */
export function searchReportPage({ user, client, report, site, history, flash, placesConfigured }) {
  const nav = `<a href="/admin">Admin</a><a href="/app">Dashboard</a><a href="/logout">Sign out</a>`;
  const back = `/admin/clients/${client.id}/search`;
  if (!site) {
    return layout(`Search — ${client.name}`, `
      ${flashHtml(flash)}
      <p><a href="/admin">← All clients</a></p>
      <h1>${esc(client.name)} · Search ladder</h1>
      <div class="card"><p class="muted">Nothing analyzed yet.</p>
        <form method="post" action="/admin/clients/${client.id}/search/analyze"><button>Analyze search</button></form>
        <p class="muted small" style="margin-top:10px">Analyzes ${esc(client.domain || 'every HTTP monitor at a site root')}. Takes a few seconds per site.</p></div>`, { nav, wide: true });
  }
  const tabs = report.sites.length > 1 ? `<p class="tabs">${report.sites.map((st) => `<a class="${st.domain === site.domain ? 'on' : ''}" href="${back}?domain=${encodeURIComponent(st.domain)}">${esc(st.domain)} · ${st.grade}/${MAX_RUNG}${st.isPrimary ? ' · primary' : ''}</a>`).join('')}</p>` : '';
  const ladderBar = `<div class="ladder">${Array.from({ length: MAX_RUNG }, (_, i) => `<span class="${i + 1 <= site.grade ? 'on' : site.next && i + 1 === site.next.rung ? 'next' : ''}" title="Rung ${i + 1}: ${esc(RUNGS[i + 1].name)}"></span>`).join('')}</div>`;

  const checkItem = (id) => {
    const c = site.checks[id] || { ok: false, detail: 'not run' };
    return `<div class="item"><span class="mark ${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span><div><div>${esc(CHECKS[id].label)} <span class="muted small">· ${esc(c.detail || '')}</span></div>${c.ok ? '' : `<div class="fix">Fix: ${esc(CHECKS[id].fix)}</div>`}</div></div>`;
  };
  const attItem = (id) => {
    const a = site.attestations[id];
    const on = Boolean(a?.value);
    const def = ATTESTATIONS[id];
    return `<div class="item"><span class="mark ${on ? 'ok' : 'todo'}">${on ? '✓' : '☐'}</span><div>
      <label><input type="checkbox" name="att_${id}" ${on ? 'checked' : ''}> <span>${esc(def.label)} <span class="pill ${def.scope === 'business' ? 'info' : 'unknown'}" title="${def.scope === 'business' ? 'about the business — shared by all its sites' : 'about this site only'}">${def.scope}</span></span></label>
      <div class="fix">${esc(def.how)}${a?.set_at ? ` <span class="muted">· ${on ? 'confirmed' : 'cleared'} ${new Date(a.set_at * 1000).toLocaleDateString()}${a.set_by ? ' by ' + esc(a.set_by) : ''}</span>` : ''}</div></div></div>`;
  };

  const rungBlocks = site.rungs.map((r) => {
    const def = RUNGS.find((x) => x.rung === r.rung);
    const isNext = site.next && site.next.rung === r.rung;
    return `<div class="rung ${r.cleared ? 'cleared' : ''} ${isNext ? 'next' : ''}" id="rung-${r.rung}">
      <h4><span class="pill ${r.cleared ? 'up' : isNext ? 'warn' : 'unknown'}">${r.cleared ? 'CLEARED' : isNext ? 'NEXT PHASE' : 'LATER'}</span> Rung ${r.rung} — ${esc(r.name)}</h4>
      <div class="muted small" style="margin-bottom:6px">${esc(def.summary)}${def.why ? ` <em>${esc(def.why)}</em>` : ''}</div>
      ${def.checks.map(checkItem).join('')}
      ${def.attestations.map(attItem).join('')}
    </div>`;
  }).join('');

  const nextCard = site.next ? `
    <div class="card" style="border-color:rgba(245,158,11,.6)">
      <h2>Next phase: Rung ${site.next.rung} — ${esc(site.next.name)}</h2>
      <p class="muted">${esc(site.next.summary)} ${site.next.why ? esc(site.next.why) : ''}</p>
      ${site.next.failing.length ? `<h3>Fix on the site</h3>${site.next.failing.map(checkItem).join('')}` : ''}
      ${site.next.missing.length ? `<h3>Confirm in Google, then tick below</h3><ul>${site.next.missing.map((id) => `<li>${esc(ATTESTATIONS[id].label)} <span class="muted small">— ${esc(ATTESTATIONS[id].how)}</span></li>`).join('')}</ul>` : ''}
    </div>` : `<div class="card"><h2>Top of the ladder</h2><p class="muted">Every rung is cleared. Keep the monthly review on the calendar.</p></div>`;

  const ahead = site.ahead.length ? `<p class="muted small">Already in place higher up (not credited until the rungs below clear): ${site.ahead.map((a) => `rung ${a.rung} ${esc(a.label)}`).join(' · ')}.</p>` : '';

  const hist = history.length > 1 ? `<div class="card"><h2>History</h2><table><thead><tr><th>When</th><th>Grade</th><th>Next rung</th></tr></thead><tbody>${history.map((h) => `<tr><td>${fmtTime(h.created_at)}</td><td><strong>${h.grade}</strong></td><td>${h.next_rung ?? '—'}</td></tr>`).join('')}</tbody></table></div>` : '';

  return layout(`Search — ${client.name}`, `
    ${flashHtml(flash)}
    <p><a href="/admin">← All clients</a></p>
    <h1>${esc(client.name)} · Search ladder</h1>
    <p class="muted">Signed in as ${esc(user.email)} · <a href="https://${esc(site.domain)}/" target="_blank" rel="noopener">${esc(site.domain)}</a> · analyzed ${new Date(site.analyzedAt * 1000).toLocaleString()} · ${site.pages.length} page(s) read${site.sitemap?.count ? `, ${site.sitemap.count} in the sitemap` : ''}</p>
    ${tabs}
    <div class="card">
      <div class="row" style="align-items:center">
        <div class="auto"><span class="grade">${site.grade}<small>/ ${MAX_RUNG}</small></span></div>
        <div>${ladderBar}<div class="muted small">Green: cleared. Amber: the next phase. A rung counts only when everything on it and below it is done.</div></div>
        <div class="auto"><form method="post" action="/admin/clients/${client.id}/search/analyze" class="inline"><input type="hidden" name="domain" value="${esc(site.domain)}"><button>Re-analyze</button></form></div>
      </div>
      ${ahead}
    </div>
    ${nextCard}
    <form method="post" action="/admin/clients/${client.id}/search/attest">
      <input type="hidden" name="domain" value="${esc(site.domain)}">
      <div class="card">
        <h2>Every rung</h2>
        <p class="muted small">Ticks are attestations: things you confirmed by looking in Google. Save re-grades instantly without re-fetching the site.</p>
        ${rungBlocks}
        <h3>Business Profile Place ID</h3>
        <div class="row"><div><input name="place_id" value="${esc(client.place_id || '')}" placeholder="ChIJ…"></div><div class="auto"><button class="secondary">Save ticks + Place ID</button></div></div>
        <p class="muted small">${placesConfigured ? 'Left blank, Beakon searches Google Places for the business name and accepts a result whose website is this domain.' : 'Find it in the CRM card, or at developers.google.com/maps/documentation/places/web-service/place-id. Set GOOGLE_PLACES_API_KEY to have Beakon look it up.'}</p>
      </div>
    </form>
    ${hist}
  `, { nav, wide: true });
}

// ---------- Billing ----------
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
    <p class="muted small">Monitors set up by your provider are included and never count against a plan.</p>
    ${plans}
    ${active ? `<form method="post" action="/billing/portal"><button class="btn secondary">Manage / cancel subscription</button></form>` : ''}
  `, { nav });
}
