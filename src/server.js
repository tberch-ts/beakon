// src/server.js
// Express app: auth, dashboard, monitor CRUD, Stripe billing + webhook.
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
import { normalizeUrl } from './checks.js';
import { PLANS, planForPriceId, monitorLimit, isAccountActive } from './plans.js';
import { loginPage, signupPage, dashboard, billingPage } from './views.js';

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

function getUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}
function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  next();
}

// ---- Root ----
// The public marketing landing lives on GitHub Pages; this backend host serves
// the actual app, so send the root straight to the dashboard/login.
app.get('/', (req, res) => res.redirect(req.session.userId ? '/app' : '/login'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Auth ----
app.get('/signup', (req, res) => res.send(signupPage()));
app.post('/signup', async (req, res) => {
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

app.get('/login', (req, res) => res.send(loginPage()));
app.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.send(loginPage('Invalid email or password.'));
  }
  req.session.userId = user.id;
  res.redirect('/app');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---- Dashboard ----
app.get('/app', requireAuth, (req, res) => {
  const monitors = db.prepare('SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.send(dashboard(req.user, monitors));
});

app.post('/app/monitors', requireAuth, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM monitors WHERE user_id = ?').get(req.user.id).c;
  if (count >= monitorLimit(req.user)) return res.redirect('/billing');
  let url;
  try {
    url = normalizeUrl(req.body.url);
  } catch {
    return res.redirect('/app');
  }
  const name = (req.body.name || url).trim().slice(0, 120);
  db.prepare('INSERT INTO monitors (user_id, name, url, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(req.user.id, name, url, now());
  res.redirect('/app');
});

app.post('/app/monitors/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM monitors WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  db.prepare('DELETE FROM events WHERE monitor_id = ?').run(req.params.id);
  res.redirect('/app');
});

app.post('/app/settings', requireAuth, (req, res) => {
  const alertEmail = (req.body.alert_email || '').trim().toLowerCase();
  if (alertEmail) db.prepare('UPDATE users SET alert_email = ? WHERE id = ?').run(alertEmail, req.user.id);
  res.redirect('/app');
});

// ---- Billing ----
app.get('/billing', requireAuth, (req, res) => res.send(billingPage(req.user)));

app.post('/billing/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured.');
  const planKey = req.body.plan;
  const plan = PLANS[planKey];
  if (!plan || !plan.priceId) return res.status(400).send('Unknown or unconfigured plan.');

  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email, metadata: { user_id: String(req.user.id) } });
    customerId = customer.id;
    db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
  }

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
});

app.post('/billing/portal', requireAuth, async (req, res) => {
  if (!stripe || !req.user.stripe_customer_id) return res.redirect('/billing');
  const portal = await stripe.billingPortal.sessions.create({
    customer: req.user.stripe_customer_id,
    return_url: `${BASE_URL}/billing`,
  });
  res.redirect(303, portal.url);
});

app.listen(PORT, () => {
  console.log(`[beakon] listening on ${BASE_URL} (port ${PORT})`);
  startScheduler();
});
