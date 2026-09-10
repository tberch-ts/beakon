// src/server.js
// Express app: the operator's monitoring and search console.
//
// Beakon is an internal tool. The only people who sign in are the marketing
// CRM's admins (the `admin` custom claim on the shared Firebase project); the
// only machine that talks to it is the CRM, with a shared secret. Customers see
// an Uptime Kuma status page, not this. There is no billing, no plan, no limit:
// Beakon watches and grades whatever the CRM tells it to.
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './db.js';
import { startScheduler } from './monitor.js';
import {
  firebaseWebConfig, isFirebaseEnabled, verifyIdToken, findOrCreateUserFromFirebase, isAdminUser, getSessionUser, requireAdmin,
} from './auth.js';
import {
  getClient, getClientByCrmSlug, listClients, createClient, updateClient, updateAlertSettings, resendVerification, verifyAlertToken, deleteClient,
} from './clients.js';
import {
  getMonitor, listMonitorsForClient, listAllMonitors, recentEvents, createMonitor,
  setMonitorActive, deleteMonitor, assignMonitorToClient, syncClientMonitorsToKuma, unlinkedKumaMonitors, importKumaMonitor,
} from './monitors.js';
import { kuma, isKumaEnabled, availableMonitorTypes } from './kuma.js';
import { isMailConfigured } from './mailer.js';
import { crmWebhookAuth, upsertClientFromCrm, clientStatusForCrm, isCrmSignalConfigured, isCrmWebhookConfigured } from './crm.js';
import { loginPage, forbiddenPage, adminPage, verifyPage, searchReportPage } from './views.js';
import { analyzeClient, searchSummary, searchReportForCrm, setAttestations, auditHistory, isPlacesConfigured } from './search.js';
import { ATTESTATIONS } from './searchLadder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Behind Fly's TLS proxy, trust X-Forwarded-Proto so secure cookies are set.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// ---- Standard middleware ----
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// One-shot messages across a redirect.
function flash(req, msg, kind = 'ok') { req.session.flash = { msg, kind }; }
function takeFlash(req) { const f = req.session.flash; delete req.session.flash; return f || null; }

// ---- Root ----
app.get('/', (req, res) => res.redirect(req.session.userId ? '/admin' : '/login'));
app.get('/app', (req, res) => res.redirect('/admin'));
app.get('/healthz', (req, res) => res.json({
  ok: true,
  kuma: isKumaEnabled() ? (kuma?.isReady() ? 'connected' : 'disconnected') : 'disabled',
}));

// ---- Auth: Google, via the CRM's Firebase project. Admins only. ----
app.get('/login', (req, res) => {
  const user = getSessionUser(req);
  if (user && isAdminUser(user)) return res.redirect('/admin');
  res.send(loginPage({ firebaseConfig: isFirebaseEnabled() ? firebaseWebConfig() : null, error: req.query.error }));
});

// The browser signed in with Firebase; exchange the ID token for a session.
// Non-admins get a session too, so /admin can tell them plainly why not.
app.post('/auth/firebase', async (req, res) => {
  try {
    const decoded = await verifyIdToken(String(req.body.idToken || ''));
    const user = findOrCreateUserFromFirebase(decoded);
    req.session.userId = user.id;
    res.json({ ok: true, redirect: '/admin' });
  } catch (err) {
    console.warn('[auth] firebase sign-in failed:', err.message);
    res.status(401).json({ ok: false, error: err.message });
  }
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// Signed in but not a CRM admin.
app.get('/forbidden', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/login');
  res.status(403).send(forbiddenPage(user));
});

// ---- Alert email verification (public link from the email) ----
app.get('/alerts/verify', (req, res) => {
  const client = verifyAlertToken(String(req.query.token || ''));
  if (client) syncClientMonitorsToKuma(client.id).catch(() => {});
  res.send(verifyPage(Boolean(client), client));
});

// ---- Admin console: every client, every monitor ----
app.get('/admin', requireAdmin, (req, res) => {
  const clients = listClients();
  const monitors = listAllMonitors();
  const byClient = new Map();
  for (const m of monitors) {
    if (!byClient.has(m.client_id)) byClient.set(m.client_id, []);
    byClient.get(m.client_id).push(m);
  }
  res.send(adminPage({
    user: req.user,
    clients: clients.map((c) => ({ ...c, monitors: byClient.get(c.id) || [], search: searchSummary(c.id) })),
    orphanMonitors: byClient.get(null) || [],
    monitorTypes: availableMonitorTypes(),
    kuma: {
      enabled: isKumaEnabled(), connected: Boolean(kuma?.isReady()), url: process.env.KUMA_URL || '', lastError: kuma?.lastError || null,
      channels: kuma?.isReady() ? kuma.listNotifications() : [], unlinked: unlinkedKumaMonitors(),
    },
    integrations: { mail: isMailConfigured(), crmSignals: isCrmSignalConfigured(), crmWebhook: isCrmWebhookConfigured(), firebase: isFirebaseEnabled(), places: isPlacesConfigured() },
    events: recentEvents(40),
    flash: takeFlash(req),
  }));
});

app.post('/admin/clients', requireAdmin, (req, res) => {
  try {
    const client = createClient({ name: req.body.name, slug: req.body.slug, crmSlug: req.body.crm_slug || null, domain: req.body.domain || null, source: 'admin' });
    flash(req, `Client "${client.name}" created.`);
  } catch (err) {
    flash(req, `Could not create client: ${err.message}`, 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/clients/:id/update', requireAdmin, (req, res) => {
  try {
    updateClient(parseInt(req.params.id, 10), { name: req.body.name, domain: req.body.domain || null, crmSlug: req.body.crm_slug || null });
    flash(req, 'Client saved.');
  } catch (err) {
    flash(req, `Could not save client: ${err.message}`, 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/clients/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  for (const m of listMonitorsForClient(id)) await deleteMonitor(m.id);
  deleteClient(id);
  flash(req, 'Client and its monitors deleted.');
  res.redirect('/admin');
});

app.post('/admin/clients/:id/alerts', requireAdmin, async (req, res) => {
  const client = getClient(parseInt(req.params.id, 10));
  if (!client) return res.status(404).send('No such client.');
  try {
    const r = await updateAlertSettings(client, {
      alertEmail: req.body.alert_email, alertChannel: String(req.body.alert_channel || 'email'), alertsEnabled: req.body.alerts_enabled ? 1 : 0,
      markVerified: Boolean(req.body.mark_verified),
    }, { baseUrl: BASE_URL });
    await syncClientMonitorsToKuma(client.id);
    if (r.verificationSent) flash(req, `Alert settings saved. We emailed ${r.client.alert_email} — they must click the link there before anything is sent.`);
    else if (r.verificationPending) flash(req, 'Alert settings saved. That address still needs to be confirmed before alerts are sent.', 'warn');
    else flash(req, 'Alert settings saved.');
  } catch (err) {
    flash(req, err.message, 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/clients/:id/alerts/resend', requireAdmin, async (req, res) => {
  const client = getClient(parseInt(req.params.id, 10));
  if (!client) return res.status(404).send('No such client.');
  const sent = await resendVerification(client, { baseUrl: BASE_URL });
  flash(req, sent ? `Verification email sent to ${client.alert_email}.` : 'Nothing to send.', sent ? 'ok' : 'warn');
  res.redirect('/admin');
});

app.post('/admin/monitors', requireAdmin, async (req, res) => {
  try {
    if (!getClient(parseInt(req.body.client_id, 10))) throw new Error('pick a client');
    await createMonitor({
      clientId: parseInt(req.body.client_id, 10), userId: req.user.id, name: req.body.name, url: req.body.url, type: req.body.type,
      keyword: req.body.keyword, hostname: req.body.hostname, port: req.body.port, source: 'admin',
    });
    flash(req, 'Monitor added.');
  } catch (err) {
    flash(req, `Could not add monitor: ${err.message}`, 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/monitors/:id/toggle', requireAdmin, async (req, res) => {
  const m = getMonitor(parseInt(req.params.id, 10));
  if (m) await setMonitorActive(m.id, !m.active);
  res.redirect('/admin');
});

app.post('/admin/monitors/:id/delete', requireAdmin, async (req, res) => {
  const m = getMonitor(parseInt(req.params.id, 10));
  if (m) await deleteMonitor(m.id);
  res.redirect('/admin');
});

app.post('/admin/monitors/:id/assign', requireAdmin, async (req, res) => {
  try { await assignMonitorToClient(parseInt(req.params.id, 10), parseInt(req.body.client_id, 10)); flash(req, 'Monitor moved.'); }
  catch (err) { flash(req, err.message, 'err'); }
  res.redirect('/admin');
});

app.post('/admin/kuma/import', requireAdmin, async (req, res) => {
  try {
    await importKumaMonitor(parseInt(req.body.kuma_id, 10), parseInt(req.body.client_id, 10), req.user.id);
    flash(req, 'Kuma monitor imported.');
  } catch (err) {
    flash(req, `Import failed: ${err.message}`, 'err');
  }
  res.redirect('/admin');
});

// ---- Search ladder: grade a client's search position, 0–10 ----
// The analysis fetches the site (a few seconds per site) inside the request;
// the admin console is one person clicking a button, so that is fine here.
app.get('/admin/clients/:id/search', requireAdmin, (req, res) => {
  const client = getClient(parseInt(req.params.id, 10));
  if (!client) return res.status(404).send('No such client.');
  const report = searchReportForCrm(client.id);
  const wanted = String(req.query.domain || '').toLowerCase();
  const site = report.sites.find((s) => s.domain === wanted) || report.sites.find((s) => s.isPrimary) || report.sites[0] || null;
  res.send(searchReportPage({
    user: req.user, client, report, site,
    history: site ? auditHistory(client.id, site.domain) : [],
    flash: takeFlash(req), placesConfigured: isPlacesConfigured(),
  }));
});

app.post('/admin/clients/:id/search/analyze', requireAdmin, async (req, res) => {
  const client = getClient(parseInt(req.params.id, 10));
  if (!client) return res.status(404).send('No such client.');
  try {
    const r = await analyzeClient(client, { setBy: req.user.email });
    flash(req, `Analyzed ${r.sites.length} site(s): ${r.primary.domain} is on rung ${r.primary.grade}${r.primary.next ? `, next is rung ${r.primary.next.rung} — ${r.primary.next.name}` : ''}.`);
  } catch (err) {
    flash(req, `Analysis failed: ${err.message}`, 'err');
  }
  res.redirect(`/admin/clients/${client.id}/search${req.body.domain ? `?domain=${encodeURIComponent(req.body.domain)}` : ''}`);
});

app.post('/admin/clients/:id/search/attest', requireAdmin, (req, res) => {
  const client = getClient(parseInt(req.params.id, 10));
  if (!client) return res.status(404).send('No such client.');
  const domain = String(req.body.domain || '').toLowerCase();
  // Every attestation is a checkbox; an unticked box is simply absent from the
  // body, so the whole set is written each time — unchecked means false.
  const values = {};
  for (const key of Object.keys(ATTESTATIONS)) values[key] = Boolean(req.body[`att_${key}`]);
  setAttestations(client.id, domain, values, req.user.email);
  const placeId = String(req.body.place_id || '').trim().slice(0, 200) || null;
  const placeChanged = placeId !== (client.place_id || null);
  if (placeChanged) db.prepare('UPDATE clients SET place_id = ? WHERE id = ?').run(placeId, client.id);
  flash(req, placeChanged ? 'Attestations and Place ID saved. Re-analyze to credit the Place ID.' : 'Attestations saved and re-graded.');
  res.redirect(`/admin/clients/${client.id}/search?domain=${encodeURIComponent(domain)}`);
});

// ---- CRM: the only machine caller. Bearer = CRM_WEBHOOK_TOKEN. ----
// `:slug` is the client's slug AS THE CRM KNOWS IT. It matches a client's
// crm_slug first, then its own slug, so a client created here by hand links up
// the moment its "CRM slug" field is filled in.
app.post('/api/crm/clients', crmWebhookAuth, async (req, res) => {
  try {
    const result = await upsertClientFromCrm(req.body || {}, { baseUrl: BASE_URL });
    res.status(result.created ? 201 : 200).json({
      ok: true, created: result.created,
      client: { id: result.client.id, slug: result.client.slug, crmSlug: result.client.crm_slug, name: result.client.name },
      owners: [], verificationSent: result.verificationSent, monitors: result.monitors, monitorCount: result.monitorCount,
      dashboardUrl: `${BASE_URL}/admin`,
    });
  } catch (err) {
    console.error('[crm] upsert failed:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/crm/clients/:slug', crmWebhookAuth, (req, res) => {
  const client = getClientByCrmSlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, ...clientStatusForCrm(client) });
});

// The CRM's "Analyze search" button lands here. Body: { placeId?, domains? }.
app.post('/api/crm/clients/:slug/search/analyze', crmWebhookAuth, async (req, res) => {
  const client = getClientByCrmSlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const body = req.body || {};
    await analyzeClient(client, { placeId: body.placeId || null, domains: Array.isArray(body.domains) ? body.domains : null, setBy: 'crm' });
    res.json({ ok: true, reportUrl: `${BASE_URL}/admin/clients/${client.id}/search`, ...searchReportForCrm(client.id) });
  } catch (err) {
    console.error('[search] analyze failed:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/crm/clients/:slug/search', crmWebhookAuth, (req, res) => {
  const client = getClientByCrmSlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, reportUrl: `${BASE_URL}/admin/clients/${client.id}/search`, ...searchReportForCrm(client.id) });
});

// Body: { domain?, attestations: { key: boolean } }. Lets the CRM tick
// "profile verified" when the card deal passes gbp_setup, for instance.
app.put('/api/crm/clients/:slug/search/attestations', crmWebhookAuth, (req, res) => {
  const client = getClientByCrmSlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  const body = req.body || {};
  const domain = String(body.domain || client.domain || '').toLowerCase();
  setAttestations(client.id, domain, body.attestations || {}, 'crm');
  res.json({ ok: true, ...searchReportForCrm(client.id) });
});

// Safety net: log unexpected async errors instead of letting them crash the app.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

app.listen(PORT, () => {
  console.log(`[beakon] listening on ${BASE_URL} (port ${PORT})`);
  startScheduler();
});
