// src/auth.js
// Identity. Beakon has exactly one kind of user: an admin of the marketing CRM.
//
// Sign-in is Google through the SAME Firebase project marketingCRM uses
// (marketingcrm-c5d57). The CRM's `admin` custom claim (set with its set-admin
// script) is what makes somebody an admin here — there is no separate admin
// list, no password login, no customer role. Somebody who signs in without the
// claim gets a session that can only see /forbidden.
//
// The browser signs in with the Firebase web SDK and posts the ID token to
// POST /auth/firebase; this module verifies it with firebase-admin and maps it
// onto a row in `users`. Sessions themselves stay as express-session cookies.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT_JSON   service account JSON, raw or base64 (server side)
//   FIREBASE_WEB_API_KEY / FIREBASE_WEB_AUTH_DOMAIN / FIREBASE_WEB_PROJECT_ID /
//   FIREBASE_WEB_APP_ID             the public web config (browser side)
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

/** Verify a Firebase ID token. Throws if Firebase is not configured or the token is bad. */
export async function verifyIdToken(idToken) {
  const app = await getAdminApp();
  if (!app) throw new Error('Firebase sign-in is not configured on the server.');
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(app).verifyIdToken(idToken, true);
}

/**
 * Map a verified Firebase identity onto a `users` row: by uid first, then by
 * email, else create. The role is re-read from the claim on every sign-in, so
 * revoking `admin` in the CRM takes effect the next time they sign in here.
 */
export function findOrCreateUserFromFirebase(decoded) {
  const email = (decoded.email || '').toLowerCase();
  if (!email) throw new Error('Google account has no email address.');
  const role = decoded.admin === true ? 'admin' : 'customer';

  let user = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(decoded.uid);
  if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    db.prepare('UPDATE users SET firebase_uid = ?, role = ?, last_login_at = ? WHERE id = ?')
      .run(decoded.uid, role, now(), user.id);
  } else {
    const info = db.prepare(`
      INSERT INTO users (email, password_hash, firebase_uid, role, alert_email, created_at, last_login_at)
      VALUES (?, '', ?, ?, ?, ?, ?)
    `).run(email, decoded.uid, role, email, now(), now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

export function isAdminUser(user) {
  return Boolean(user && user.role === 'admin');
}

// ---- Express helpers ----
export function getSessionUser(req) {
  if (!req.session?.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}

/** Every human-facing route: a signed-in CRM admin, or a redirect. */
export function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/login');
  if (!isAdminUser(user)) return res.redirect('/forbidden');
  req.user = user;
  req.isAdmin = true;
  next();
}
