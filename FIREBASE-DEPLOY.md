# Beakon on Firebase — Deploy Guide

Beakon runs entirely on the Firebase serverless model:

| Piece | Firebase service | File(s) |
|---|---|---|
| Landing + dashboard | **Hosting** | `public/index.html`, `public/app.html` |
| Login / signup | **Firebase Authentication** (Email/Password) | handled in `app.html` |
| Data | **Firestore** | collections `users`, `monitors`, `events` |
| API | **Cloud Functions** → `api` | `functions/index.js` |
| Stripe webhook | **Cloud Functions** → `stripeWebhook` | `functions/index.js` |
| Every-minute checks | **Cloud Scheduler + Function** → `runChecks` | `functions/index.js`, `functions/monitor.js` |

> **Plan note:** Cloud Functions that make outbound network calls (pinging your monitored sites) and scheduled functions require the **Blaze** (pay-as-you-go) plan. At low volume you stay inside the free monthly quota and pay ~nothing, but a billing account must be attached.

---

## One-time setup

### 1. Tools
```bash
npm install -g firebase-tools
firebase login
```

### 2. Create the Firebase project
- Go to the Firebase console → **Add project**.
- Upgrade it to the **Blaze** plan (required, see note above).
- Enable **Authentication → Sign-in method → Email/Password**.
- Create a **Firestore database** (production mode).

### 3. Point the code at your project
- Edit `.firebaserc` → replace `YOUR_FIREBASE_PROJECT_ID` with your real project ID.
- In the console: **Project settings → Your apps → Web app** (create one). Copy the config object into `public/firebase-config.js`.

### 4. Install function dependencies
```bash
cd functions
npm install
cd ..
```

### 5. Configure non-secret env + secrets
```bash
# Non-secret config:
cp functions/.env.example functions/.env
# Edit functions/.env — set BASE_URL (https://YOUR_PROJECT.web.app),
# STRIPE_PRICE_STARTER, STRIPE_PRICE_AGENCY, SMTP_HOST, SMTP_PORT, SMTP_USER, ALERT_FROM.

# Secrets (stored in Google Secret Manager, prompted interactively):
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set SMTP_PASS
```

For email, sign up for a free SMTP sender (Brevo = 300/day free; Resend and Mailgun also have free tiers), verify a sender address, and use those credentials.

---

## Stripe setup
1. Create two recurring monthly Prices in the Stripe dashboard: Starter ($19) and Agency ($49). Put their `price_...` IDs in `functions/.env`.
2. Set `STRIPE_SECRET_KEY` secret (use `sk_test_...` while testing).
3. After your first deploy you'll have a webhook URL: `https://YOUR_PROJECT.web.app/stripeWebhook`. Add it as a Stripe webhook endpoint subscribed to: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Put its signing secret in the `STRIPE_WEBHOOK_SECRET` secret and redeploy.
4. Enable the Stripe **Billing Customer Portal** so "Manage / cancel" works.

---

## Run locally (emulator)
```bash
cd functions && npm install && cd ..
firebase emulators:start --only functions,firestore,auth,hosting
```
Open the Hosting URL it prints (usually http://localhost:5000). The emulator runs Auth, Firestore, the API, and Hosting together. The scheduled `runChecks` function does **not** auto-fire in the emulator — trigger a sweep manually from the Functions shell, or just test the dashboard/auth/billing flows locally and let the real schedule run in production.

> Stripe and SMTP calls hit live/test services even from the emulator, so use Stripe **test** keys and the test card `4242 4242 4242 4242`.

---

## Deploy
```bash
firebase deploy
```
This pushes Hosting, Functions, Firestore rules, and indexes. First deploy of `runChecks` automatically provisions the Cloud Scheduler job (every 1 minute).

Your app is live at `https://YOUR_PROJECT.web.app`:
- `/` → landing page
- `/app` → sign up, add monitors, manage billing

To deploy pieces individually: `firebase deploy --only hosting` / `--only functions` / `--only firestore`.

---

## How it runs in production
- `runChecks` fires every minute, reads all active monitors from Firestore, checks each site (HTTP status + SSL expiry), writes status back, and emails the account's alert address on any down/recovered/cert-expiring transition.
- The browser never touches Firestore directly — all reads/writes go through the `api` function, which verifies the caller's Firebase ID token. `firestore.rules` denies all direct client access by design.
- Costs scale with monitor count × checks/day. A few hundred monitors stays near the free tier.

## Custom domain (optional)
Firebase console → Hosting → **Add custom domain** (e.g. `app.beakon.com`). Update `BASE_URL` in `functions/.env` and your Stripe redirect expectations to match, then redeploy.

## Notes
- The repo also contains a legacy single-server variant (`src/` + root `package.json` + `README.md`) for a DigitalOcean droplet. The Firebase deployment ignores it; you can delete `src/`, the root `package.json`/`.env.example`, and `public/landing.html` if you want a pure-Firebase repo. The Firebase app uses `public/index.html`, `public/app.html`, `public/firebase-config.js`, and `functions/`.
