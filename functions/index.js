// functions/index.js
// Beakon backend on Firebase: HTTPS API, Stripe webhook, scheduled checks.
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import express from 'express';
import Stripe from 'stripe';

import { runSweep } from './monitor.js';
import { normalizeUrl } from './checks.js';
import { PLANS, TRIAL_DAYS, nowSec, priceIdFor, planForPriceId, monitorLimit, isAccountActive, trialDaysLeft } from './plans.js';

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// Secrets (set with: firebase functions:secrets:set NAME)
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const SMTP_PASS = defineSecret('SMTP_PASS');

function stripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// ---------- Shared helpers ----------
async function ensureUser(uid, email) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return { ref, user: snap.data() };
  const user = {
    email: email || null,
    alertEmail: email || null,
    plan: 'trial',
    subscriptionStatus: 'trialing',
    trialEndsAt: nowSec() + TRIAL_DAYS * 86400,
    stripeCustomerId: null,
    createdAt: nowSec(),
  };
  await ref.set(user);
  return { ref, user };
}

// ---------- API (Express) ----------
const app = express();
app.use(express.json());

// Verify the Firebase Auth ID token on every API call.
app.use(async (req, res, next) => {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const decoded = await getAuth().verifyIdToken(m[1]);
    req.uid = decoded.uid;
    req.email = decoded.email || null;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
});

app.get('/api/me', async (req, res) => {
  const { user } = await ensureUser(req.uid, req.email);
  const count = (await db.collection('monitors').where('uid', '==', req.uid).count().get()).data().count;
  res.json({
    email: user.email,
    alertEmail: user.alertEmail,
    plan: user.plan,
    planLabel: PLANS[user.plan]?.label || user.plan,
    subscriptionStatus: user.subscriptionStatus,
    trialDaysLeft: trialDaysLeft(user),
    active: isAccountActive(user),
    limit: monitorLimit(user),
    monitorCount: count,
  });
});

app.get('/api/monitors', async (req, res) => {
  const snap = await db.collection('monitors').where('uid', '==', req.uid).orderBy('createdAt', 'desc').get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

app.post('/api/monitors', async (req, res) => {
  const { user } = await ensureUser(req.uid, req.email);
  const count = (await db.collection('monitors').where('uid', '==', req.uid).count().get()).data().count;
  if (count >= monitorLimit(user)) return res.status(402).json({ error: 'limit_reached' });
  let url;
  try {
    url = normalizeUrl(req.body.url);
  } catch {
    return res.status(400).json({ error: 'invalid_url' });
  }
  const name = String(req.body.name || url).trim().slice(0, 120);
  const ref = await db.collection('monitors').add({
    uid: req.uid, name, url, active: true,
    lastStatus: null, lastCheckedAt: null, lastResponseMs: null, lastError: null,
    sslExpiresAt: null, sslWarnedAt: null, createdAt: nowSec(),
  });
  res.json({ id: ref.id });
});

app.post('/api/monitors/:id/delete', async (req, res) => {
  const ref = db.collection('monitors').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== req.uid) return res.status(404).json({ error: 'not_found' });
  await ref.delete();
  res.json({ ok: true });
});

app.post('/api/settings', async (req, res) => {
  await ensureUser(req.uid, req.email);
  const alertEmail = String(req.body.alertEmail || '').trim().toLowerCase();
  if (alertEmail) await db.collection('users').doc(req.uid).update({ alertEmail });
  res.json({ ok: true });
});

app.post('/api/billing/checkout', async (req, res) => {
  const { ref, user } = await ensureUser(req.uid, req.email);
  const planKey = req.body.plan;
  const priceId = priceIdFor(planKey, process.env);
  if (!priceId) return res.status(400).json({ error: 'unknown_plan' });

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe().customers.create({ email: user.email || undefined, metadata: { uid: req.uid } });
    customerId = customer.id;
    await ref.update({ stripeCustomerId: customerId });
  }
  const base = process.env.BASE_URL || `https://${req.hostname}`;
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: req.uid,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/app?success=1`,
    cancel_url: `${base}/app?canceled=1`,
    metadata: { uid: req.uid },
  });
  res.json({ url: session.url });
});

app.post('/api/billing/portal', async (req, res) => {
  const { user } = await ensureUser(req.uid, req.email);
  if (!user.stripeCustomerId) return res.status(400).json({ error: 'no_customer' });
  const base = process.env.BASE_URL || `https://${req.hostname}`;
  const portal = await stripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${base}/app`,
  });
  res.json({ url: portal.url });
});

export const api = onRequest({ secrets: [STRIPE_SECRET_KEY] }, app);

// ---------- Stripe webhook (raw body) ----------
export const stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    let event;
    try {
      event = stripe().webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[stripe] signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      const obj = event.data.object;
      if (event.type === 'checkout.session.completed') {
        const uid = obj.client_reference_id || obj.metadata?.uid;
        if (uid && obj.customer) await db.collection('users').doc(uid).set({ stripeCustomerId: obj.customer }, { merge: true });
      }
      if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
        const priceId = obj.items?.data?.[0]?.price?.id;
        const plan = planForPriceId(priceId, process.env) || 'starter';
        const status = (obj.status === 'active' || obj.status === 'trialing') ? 'active' : obj.status;
        await updateUserByCustomer(obj.customer, { plan, subscriptionStatus: status });
      }
      if (event.type === 'customer.subscription.deleted') {
        await updateUserByCustomer(obj.customer, { subscriptionStatus: 'canceled' });
      }
    } catch (err) {
      console.error('[stripe] handler error:', err.message);
    }
    res.json({ received: true });
  }
);

async function updateUserByCustomer(customerId, fields) {
  const snap = await db.collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
  if (!snap.empty) await snap.docs[0].ref.update(fields);
}

// ---------- Scheduled monitor sweep (every minute) ----------
export const runChecks = onSchedule(
  { schedule: 'every 1 minutes', secrets: [SMTP_PASS], timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const { checked } = await runSweep(db);
    console.log(`[runChecks] swept ${checked} active monitor(s)`);
  }
);
