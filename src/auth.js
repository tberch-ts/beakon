// src/auth.js
// Identity. One Google identity per person, verified through the same Firebase
// project marketingCRM uses (marketingcrm-c5d57), so a customer signs in to
// their CRM portal and to Beakon with one account, and the operator's `admin`
// custom claim (set with the CRM's setAdmin script) makes them an admin here too.
//
// The browser signs in with the Firebase web SDK and posts the ID token to
// POST /auth/firebase; this module verifies it with firebase-admin and maps it
// onto a row in `users`. Sessions themselves stay as express-session cookies.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT_JSON   service account JSON, raw or base64 (server side)
//   FIREBASE_WEB_API_KEY / FIREBASE_WEB_AUTH_DOMAIN / FIREBASE_WEB_PROJECT_ID /
//   FIREBASE_WEB_APP_ID             the public web config (browser side)
//   ADMIN_EMAILS                    comma-separated fallback admin list
//   LEGACY_PASSWORD_LOGIN=true      keep the old email+password form available
import { db, now } from './db.js';

let adminApp = null;
let initError = null;

function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function getAdminApp() {
  if (adminApp) return adminApp;
  if (initError) return null;
  try {
    const sa = loadServiceAccount();
    if (!sa) return null;
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    adminApp = getApps()[0] || initializeApp({ credential: cert(sa) });
    console.log('[auth] firebase admin initialised for project', sa.project_id);
    return adminApp;
  } catch (err) {
    initError = err;
    console.error('[auth] firebase admin init failed:', err.message);
    return null;
  }
}

export function firebaseWebConfig() {
  const cfg = {
    apiKey: process.env.FIREBASE_WEB_API_KEY || '',
    authDomain: process.env.FIREBASE_WEB_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_WEB_PROJECT_ID || '',
    appId: process.env.FIREBASE_WEB_APP_ID || '',
  };
  return cfg.apiKey && cfg.authDomain && cfg.projectId ? cfg : null;
}

export function isFirebaseEnabled() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON && firebaseWebConfig());
}

export function isLegacyPasswordLoginEnabled() {
  // Default: on until Firebase is configured, so existing accounts keep working.
  if (process.env.LEGACY_PASSWORD_LOGIN) return process.env.LEGACY_PASSWORD_LOGIN === 'true';
  return !isFirebaseEnabled();
}

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isAdminIdentity(decoded) {
  if (decoded?.admin === true) return true;
  const email = (decoded?.email || '').toLowerCase();
  return Boolean(email && adminEmails().includes(email));
}

/** Verify a Firebase ID token. Throws if Firebase is not configured or the token is bad. */
export async function verifyIdToken(idToken) {
  const app = await getAdminApp();
  if (!app) throw new Error('Firebase sign-in is not configured on the server.');
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(app).verifyIdToken(idToken, true);
}

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);

/**
 * Map a verified Firebase identity onto a `users` row: by uid first, then by
 * email (linking a pre-Firebase password account to its Google identity), else
 * create. Also refreshes the role and links any client_users grants by email.
 */
export function findOrCreateUserFromFirebase(decoded) {
  const email = (decoded.email || '').toLowerCase();
  if (!email) throw new Error('Google account has no email address.');
  const role = isAdminIdentity(decoded) ? 'admin' : 'customer';

  let user = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(decoded.uid);
  if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    db.prepare('UPDATE users SET firebase_uid = ?, role = ?, last_login_at = ? WHERE id = ?')
      .run(decoded.uid, role, now(), user.id);
  } else {
    const info = db.prepare(`
      INSERT INTO users (email, password_hash, firebase_uid, role, alert_email, plan, subscription_status, trial_ends_at, created_at, last_login_at)
      VALUES (?, '', ?, ?, ?, 'trial', 'trialing', ?, ?, ?)
    `).run(email, decoded.uid, role, email, now() + TRIAL_DAYS * 86400, now(), now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  linkClientGrants(user);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

/** Attach this user to every client_users grant that names their email. */
export function linkClientGrants(user) {
  db.prepare('UPDATE client_users SET user_id = ? WHERE lower(email) = ? AND (user_id IS NULL OR user_id != ?)')
    .run(user.id, (user.email || '').toLowerCase(), user.id);
}

export function isAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return adminEmails().includes((user.email || '').toLowerCase());
}

// ---- Express helpers ----
export function getSessionUser(req) {
  if (!req.session?.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}

export function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  req.isAdmin = isAdminUser(user);
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.isAdmin) return res.status(403).send('Admins only.');
    next();
  });
}
