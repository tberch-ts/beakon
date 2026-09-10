// src/server.js
// Express app: auth (Google via Firebase, plus legacy password), customer
// dashboard, admin console, alert-email verification, Stripe billing + webhook,
// and the CRM onboarding webhook.
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

import { db, now } from './db.js';
import { startScheduler } from './monitor.js';
import { PLANS, planForPriceId, monitorLimit } from './plans.js';
import {
  firebaseWebConfig, isFirebaseEnabled, isLegacyPasswordLoginEnabled, verifyIdToken,
  findOrCreateUserFromFirebase, linkClientGrants, isAdminUser, getSessionUser, requireAuth, requireAdmin,
} from './auth.js';
import {
  getClient, listClients, listClientsForUser, userCanAccess, ensurePersonalClient, createClient, updateClient,
  grantAccess, revokeAccess, listClientUsers, updateAlertSettings, resendVerification, verifyAlertToken, deleteClient,
} from './clients.js';
import {
  getMonitor, listMonitorsForClient, listAllMonitors, countBillableMonitors, recentEvents, createMonitor,
  setMonitorActive, deleteMonitor, assignMonitorToClient, syncClientMonitorsToKuma, unlinkedKumaMonitors, importKumaMonitor,
} from './monitors.js';
import { kuma, isKumaEnabled, availableMonitorTypes } from './kuma.js';
import { isMailConfigured } from './mailer.js';
import { crmWebhookAuth, upsertClientFromCrm, clientStatusForCrm, isCrmSignalConfigured, isCrmWebhookConfigured } from './crm.js';
import { loginPage, signupPage, dashboard, adminPage, billingPage, verifyPage, searchReportPage } from './views.js';
import { analyzeClient, searchSummary, searchReportForCrm, setAttestations, auditHistory, isPlacesConfigured } from './search.js';
import { ATTESTATIONS } from './searchLadder.js';
import { getClientBySlug } from './clients.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);

// Behind Fly/Render/DO's TLS proxy, trust the X-Forwarded-Proto header so that
// secure session cookies are set correctly in production.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ---- Stripe webhook needs the RAW body, so mount it BEFORE json parser ----
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id || s.metadata?.user_id;
      const customerId = s.customer;
      if (userId) {
        db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const sub = event.data.object;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = planForPriceId(priceId) || 'starter';
      const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status;
      db.prepare('UPDATE users SET plan = ?, subscription_status = ? WHERE stripe_customer_id = ?')
        .run(plan, status, sub.customer);
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      db.prepare("UPDATE users SET subscription_status = 'canceled' WHERE stripe_customer_id = ?")
        .run(sub.customer);
    }
  } catch (err) {
    console.error('[stripe] webhook handler error:', err.message);
  }
  res.json({ received: true });
});

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

// Serve the marketing landing page assets.
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// One-shot messages across a redirect.
function flash(req, msg, kind = 'ok') { req.session.flash = { msg, kind }; }
function takeFlash(req) { const f = req.session.flash; delete req.session.flash; return f || null; }

// ---- Root ----
app.get('/', (req, res) => res.redirect(req.session.userId ? '/app' : '/login'));
app.get('/healthz', (req, res) => res.json({
  ok: true,
  kuma: isKumaEnabled() ? (kuma?.isReady() ? 'connected' : 'disconnected') : 'disabled',
}));

// ---- Auth ----
const authOpts = () => ({ firebaseConfig: isFirebaseEnabled() ? firebaseWebConfig() : null, legacy: isLegacyPasswordLoginEnabled() });

app.get('/login', (req, res) => res.send(loginPage({ ...authOpts(), error: req.query.error })));

// Browser signed in with Firebase (Google); exchange the ID token for a session.
app.post('/auth/firebase', async (req, res) => {
  try {
    const decoded = await verifyIdToken(String(req.body.idToken || ''));
    const user = findOrCreateUserFromFirebase(decoded);
    req.session.userId = user.id;
    res.json({ ok: true, redirect: isAdminUser(user) ? '/admin' : '/app' });
  } catch (err) {
    console.warn('[auth] firebase sign-in failed:', err.message);
    res.status(401).json({ ok: false, error: err.message });
  }
});

app.get('/signup', (req, res) => {
  if (!isLegacyPasswordLoginEnabled()) return res.redirect('/login');
  res.send(signupPage());
});
app.post('/signup', async (req, res) => {
  if (!isLegacyPasswordLoginEnabled()) return res.redirect('/login');
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email || password.length < 8) return res.send(signupPage('Enter a valid email and 8+ char password.'));
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.send(signupPage('That email is already registered.'));
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, alert_email, plan, subscription_status, trial_ends_at, created_at)
    VALUES (?, ?, ?, 'trial', 'trialing', ?, ?)
  `).run(email, hash, email, now() + TRIAL_DAYS * 86400, now());
  req.session.userId = info.lastInsertRowid;
  res.redirect('/app');
});

app.post('/login', async (req, res) => {
  if (!isLegacyPasswordLoginEnabled()) return res.redirect('/login');
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return res.send(loginPage({ ...authOpts(), error: 'Invalid email or password.' }));
  }
  linkClientGrants(user);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
  req.session.userId = user.id;
  res.redirect(isAdminUser(user) ? '/admin' : '/app');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---- Alert email verification (public link from the email) ----
app.get('/alerts/verify', (req, res) => {
  const client = verifyAlertToken(String(req.query.token || ''));
  if (client) syncClientMonitorsToKuma(client.id).catch(() => {});
  res.send(verifyPage(Boolean(client), client));
});

// ---- Customer dashboard ----
function pickClient(req) {
  const clients = listClientsForUser(req.user, req.isAdmin);
  if (!clients.length && !req.isAdmin) clients.push(ensurePersonalClient(req.user));
  const wanted = parseInt(req.query.client || req.session.lastClientId || '0', 10);
  const client = clients.find((c) => c.id === wanted) || clients[0] || null;
  if (client) req.session.lastClientId = client.id;
  return { clients, client };
}

app.get('/app', requireAuth, (req, res) => {
  const { clients, client } = pickClient(req);
  const monitors = client ? listMonitorsForClient(client.id) : [];
  res.send(dashboard({
    user: req.user, isAdmin: req.isAdmin, clients, client, monitors,
    monitorTypes: availableMonitorTypes(),
    used: countBillableMonitors(req.user.id), limit: monitorLimit(req.user),
    events: client ? recentEvents(15, client.id) : [],
    kumaChannels: req.isAdmin && kuma?.isReady() ? kuma.listNotifications() : [],
    flash: takeFlash(req), mailConfigured: isMailConfigured(),
  }));
});

function requireClientAccess(req, res, clientId) {
  const id = parseInt(clientId, 10);
  if (!id || !userCanAccess(req.user, req.isAdmin, id)) { res.status(403).send('Not your client.'); return null; }
  return getClient(id);
}

app.post('/app/monitors', requireAuth, async (req, res) => {
  const client = requireClientAccess(req, res, req.body.client_id);
  if (!client) return;
  const source = req.isAdmin ? 'admin' : 'user';
  if (source === 'user' && countBillableMonitors(req.user.id) >= monitorLimit(req.user)) return res.redirect('/billing');
  try {
    await createMonitor({
      clientId: client.id, userId: req.user.id, name: req.body.name, url: req.body.url, type: req.body.type,
      keyword: req.body.keyword, hostname: req.body.hostname, port: req.body.port, source,
    });
    flash(req, 'Monitor added.');
  } catch (err) {
    flash(req, `Could not add monitor: ${err.message}`, 'err');
  }
  res.redirect(`/app?client=${client.id}`);
});

function ownedMonitor(req, res) {
  const m = getMonitor(parseInt(req.params.id, 10));
  if (!m || !userCanAccess(req.user, req.isAdmin, m.client_id)) { res.status(404).send('Not found.'); return null; }
  return m;
}

app.post('/app/monitors/:id/toggle', requireAuth, async (req, res) => {
  const m = ownedMonitor(req, res);
  if (!m) return;
  await setMonitorActive(m.id, !m.active);
  res.redirect(req.body.back || `/app?client=${m.client_id}`);
});

app.post('/app/monitors/:id/delete', requireAuth, async (req, res) => {
  const m = ownedMonitor(req, res);
  if (!m) return;
  // Customers can only remove what they added; admin/CRM monitors are managed by us.
  if (!req.isAdmin && m.source !== 'user') { flash(req, 'That monitor is managed by your provider.', 'err'); return res.redirect(`/app?client=${m.client_id}`); }
  await deleteMonitor(m.id);
  res.redirect(req.body.back || `/app?client=${m.client_id}`);
});

app.post('/app/clients/:id/alerts', requireAuth, async (req, res) => {
  const client = requireClientAccess(req, res, req.params.id);
  if (!client) return;
  let channel = String(req.body.alert_channel || 'email');
  if (channel.startsWith('kuma:') && !req.isAdmin) channel = 'email';
  try {
    const r = await updateAlertSettings(client, {
      alertEmail: req.body.alert_email, alertChannel: channel, alertsEnabled: req.body.alerts_enabled ? 1 : 0,
      markVerified: req.isAdmin && Boolean(req.body.mark_verified),
    }, { baseUrl: BASE_URL });
    await syncClientMonitorsToKuma(client.id);
    if (r.verificationSent) flash(req, `Alert settings saved. We emailed ${r.client.alert_email} — click the link there to confirm it.`);
    else if (r.verificationPending) flash(req, 'Alert settings saved. That address still needs to be confirmed before alerts are sent.', 'warn');
    else flash(req, 'Alert settings saved.');
  } catch (err) {
    flash(req, err.message, 'err');
  }
  res.redirect(req.body.back || `/app?client=${client.id}`);
});

app.post('/app/clients/:id/alerts/resend', requireAuth, async (req, res) => {
  const client = requireClientAccess(req, res, req.params.id);
  if (!client) return;
  const sent = await resendVerification(client, { baseUrl: BASE_URL });
  flash(req, sent ? `Verification email sent to ${client.alert_email}.` : 'Nothing to send.', sent ? 'ok' : 'warn');
  res.redirect(req.body.back || `/app?client=${client.id}`);
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
    clients: clients.map((c) => ({ ...c, monitors: byClient.get(c.id) || [], users: listClientUsers(c.id), search: searchSummary(c.id) })),
    orphanMonitors: byClient.get(null) || [],
    monitorTypes: availableMonitorTypes(),
    kuma: {
      enabled: isKumaEnabled(), connected: Boolean(kuma?.isReady()), url: process.env.KUMA_URL || '', lastError: kuma?.lastError || null,
      channels: kuma?.isReady() ? kuma.listNotifications() : [], unlinked: unlinkedKumaMonitors(),
    },
    integrations: { mail: isMailConfigured(), crmSignals: isCrmSignalConfigured(), crmWebhook: isCrmWebhookConfigured(), firebase: isFirebaseEnabled() },
    events: recentEvents(40),
    flash: takeFlash(req),
  }));
});

app.post('/admin/clients', requireAdmin, (req, res) => {
  try {
    const client = createClient({ name: req.body.name, slug: req.body.slug, domain: req.body.domain || null, source: 'admin' });
    if (req.body.owner_email) grantAccess(client.id, req.body.owner_email);
    flash(req, `Client "${client.name}" created.`);
  } catch (err) {
    flash(req, `Could not create client: ${err.message}`, 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/clients/:id/update', requireAdmin, (req, res) => {
  updateClient(parseInt(req.params.id, 10), { name: req.body.name, domain: req.body.domain || null });
  res.redirect('/admin');
});

app.post('/admin/clients/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  for (const m of listMonitorsForClient(id)) await deleteMonitor(m.id);
  deleteClient(id);
  flash(req, 'Client and its monitors deleted.');
  res.redirect('/admin');
});

app.post('/admin/clients/:id/users', requireAdmin, (req, res) => {
  try { grantAccess(parseInt(req.params.id, 10), req.body.email); flash(req, `Access granted to ${String(req.body.email).toLowerCase()}.`); }
  catch (err) { flash(req, err.message, 'err'); }
  res.redirect('/admin');
});

app.post('/admin/clients/:id/users/remove', requireAdmin, (req, res) => {
  revokeAccess(parseInt(req.params.id, 10), req.body.email);
  res.redirect('/admin');
});

app.post('/admin/monitors', requireAdmin, async (req, res) => {
  try {
    if (!getClient(parseInt(req.body.client_id, 10))) throw new Error('pick a client');
    await createMonitor({
      clientId: parseInt(req.body.client_id, 10), userId: req.user.id, name: req.body.name, url: req.body.url, type: req.body.type,
      keyword: req.body.keyword, hostname: req.body.hostname, port: req.body.port, source: 'admin',
    });
    flash(req, 'Monitor added (not billed to the client).');
  } catch (err) {
    flash(req, `Could not add monitor: ${err.message}`, 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/monitors/:id/assign', requireAdmin, async (req, res) => {
  try { await assignMonitorToClient(parseInt(req.params.id, 10), parseInt(req.body.client_id, 10)); flash(req, 'Monitor moved.'); }
  catch (err) { flash(req, err.message, 'err'); }
  res.redirect('/admin');
});

app.post('/admin/monitors/:id/billable', requireAdmin, (req, res) => {
  const m = getMonitor(parseInt(req.params.id, 10));
  if (m) db.prepare('UPDATE monitors SET billable = ? WHERE id = ?').run(m.billable ? 0 : 1, m.id);
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

// The CRM's "Analyze search" button lands here. Body: { placeId?, domains? }.
app.post('/api/crm/clients/:slug/search/analyze', crmWebhookAuth, async (req, res) => {
  const client = getClientBySlug(String(req.params.slug).toLowerCase());
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
  const client = getClientBySlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, reportUrl: `${BASE_URL}/admin/clients/${client.id}/search`, ...searchReportForCrm(client.id) });
});

// Body: { domain?, attestations: { key: boolean } }. Lets the CRM tick
// "profile verified" when the card deal passes gbp_setup, for instance.
app.put('/api/crm/clients/:slug/search/attestations', crmWebhookAuth, (req, res) => {
  const client = getClientBySlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  const body = req.body || {};
  const domain = String(body.domain || client.domain || '').toLowerCase();
  setAttestations(client.id, domain, body.attestations || {}, 'crm');
  res.json({ ok: true, ...searchReportForCrm(client.id) });
});

// ---- CRM webhook: onboarding creates the client + monitors here ----
app.post('/api/crm/clients', crmWebhookAuth, async (req, res) => {
  try {
    const result = await upsertClientFromCrm(req.body || {}, { baseUrl: BASE_URL });
    res.status(result.created ? 201 : 200).json({
      ok: true, created: result.created,
      client: { id: result.client.id, slug: result.client.slug, name: result.client.name },
      owners: result.owners, verificationSent: result.verificationSent, monitors: result.monitors, monitorCount: result.monitorCount,
      dashboardUrl: `${BASE_URL}/app?client=${result.client.id}`,
    });
  } catch (err) {
    console.error('[crm] upsert failed:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/crm/clients/:slug', crmWebhookAuth, (req, res) => {
  const client = getClientBySlug(String(req.params.slug).toLowerCase());
  if (!client) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, ...clientStatusForCrm(client) });
});

// ---- Billing ----
app.get('/billing', requireAuth, (req, res) => res.send(billingPage(req.user)));

// Return a valid Stripe customer id for this user. If the saved id no longer
// exists in the current Stripe account/mode (e.g. the key changed), transparently
// create a fresh customer and persist it — so a stale id never breaks checkout.
async function ensureStripeCustomer(user) {
  if (user.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(user.stripe_customer_id);
      if (existing && !existing.deleted) return user.stripe_customer_id;
    } catch (err) {
      console.warn(`[stripe] stale customer ${user.stripe_customer_id} for user ${user.id}; recreating`);
    }
  }
  const customer = await stripe.customers.create({ email: user.email, metadata: { user_id: String(user.id) } });
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer.id, user.id);
  return customer.id;
}

app.post('/billing/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured.');
  const plan = PLANS[req.body.plan];
  if (!plan || !plan.priceId) return res.status(400).send('Unknown or unconfigured plan.');
  try {
    const customerId = await ensureStripeCustomer(req.user);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(req.user.id),
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: `${BASE_URL}/billing?success=1`,
      cancel_url: `${BASE_URL}/billing?canceled=1`,
      metadata: { user_id: String(req.user.id) },
    });
    res.redirect(303, checkout.url);
  } catch (err) {
    console.error('[stripe] checkout failed:', err.message);
    res.status(400).send(`Could not start checkout: ${err.message}`);
  }
});

app.post('/billing/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.redirect('/billing');
  try {
    const customerId = await ensureStripeCustomer(req.user);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${BASE_URL}/billing`,
    });
    res.redirect(303, portal.url);
  } catch (err) {
    console.error('[stripe] portal failed:', err.message);
    res.redirect('/billing');
  }
});

// TEMP diagnostic — reveals what the RUNNING app actually has (no secrets leaked).
// Remove after debugging.
app.get('/debug/stripe', async (req, res) => {
  const k = process.env.STRIPE_SECRET_KEY || '';
  const keyMode = k.startsWith('sk_live') ? 'live' : k.startsWith('sk_test') ? 'test' : (k ? 'unknown' : 'UNSET');
  const priceStarter = process.env.STRIPE_PRICE_STARTER || null;
  const priceAgency = process.env.STRIPE_PRICE_AGENCY || null;
  let priceCheck;
  try {
    const p = await stripe.prices.retrieve(priceStarter);
    priceCheck = { ok: true, id: p.id, livemode: p.livemode, amount: p.unit_amount };
  } catch (e) {
    priceCheck = { ok: false, error: e.message };
  }
  res.json({ keyMode, keyLast4: k.slice(-4), priceStarter, priceAgency, priceCheck });
});

// Safety net: log unexpected async errors instead of letting them crash the app.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

app.listen(PORT, () => {
  console.log(`[beakon] listening on ${BASE_URL} (port ${PORT})`);
  startScheduler();
});
