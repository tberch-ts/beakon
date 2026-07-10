# Beakon — GitHub Pages + Cheap Backend (no Firebase)

This is the "host it on GitHub like my resume" setup. It splits Beakon into two
pieces, because a paid SaaS can't run entirely on static GitHub Pages:

```
  GitHub Pages (free, static)            Cheap always-on host (the backend)
  ───────────────────────────           ──────────────────────────────────
  docs/index.html  = marketing   ──▶     Express app in src/  (Node + SQLite)
  landing page, exactly like              • signup / login / dashboard
  your resume is hosted.                  • every-minute uptime + SSL checks
  "Start free" links to the app.          • Stripe billing + webhook
```

**Why the split?** GitHub Pages only serves static files — it runs no code, has
no database, and can't hold secret keys. The monitoring loop, the database, and
your Stripe secret key all need a real backend. So Pages hosts the free
marketing page, and the app itself runs on a small always-on host.

---

## Part 1 — The landing page on GitHub Pages (free)

1. Push this repo to GitHub (see Part 3 if it isn't there yet).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch = `main`, folder = **`/docs`**. Save.
3. Wait ~1 minute. Your landing page is live at `https://<your-username>.github.io/<repo>/`.
4. Edit **one line** in `docs/index.html` — set `APP_URL` to your backend URL (from Part 2) so the "Start free" buttons point to the app:
   ```js
   const APP_URL = "https://beakon.fly.dev";   // or your custom domain
   ```
5. (Optional) Custom domain like your resume: **Settings → Pages → Custom domain**, add `beakon.com`, and set the DNS records GitHub shows. Add a `docs/CNAME` file containing the domain.

That's the whole static side — identical hosting model to your resume.

---

## Part 2 — The backend on a cheap always-on host

The backend is the existing Express app in `src/`. It needs to run 24/7 (so the
minute-by-minute checks keep firing) and persist a small SQLite file. Pick one:

| Host | Cost for always-on + storage | Notes |
|---|---|---|
| **Fly.io** | Small free allowance, then a few $/mo | `fly.toml` included. Good default. |
| **Railway** | ~$5/mo credit | Simplest UI; add a volume at `/data`. |
| **Render** | ~$7/mo (starter) | `render.yaml` included. Free tier sleeps + wipes disk — not suitable. |
| **DigitalOcean droplet** | $6/mo | You already have this; see `README.md` for the droplet guide. |

> ⚠️ Avoid "free" tiers that sleep on inactivity — a sleeping backend stops
> checking sites and can reset the database. Monitoring must stay awake.

### Option A — Fly.io (recommended)
```bash
# 1. Install + login
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. From the repo root (edit the app name in fly.toml first if you like)
fly launch --no-deploy --copy-config      # registers the app, keeps fly.toml

# 3. Create the persistent volume for SQLite
fly volumes create beakon_data --region ord --size 1

# 4. Set secrets (never commit these)
fly secrets set \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  STRIPE_SECRET_KEY="sk_live_or_test_xxx" \
  STRIPE_WEBHOOK_SECRET="whsec_xxx" \
  STRIPE_PRICE_STARTER="price_xxx" \
  STRIPE_PRICE_AGENCY="price_xxx" \
  SMTP_HOST="smtp-relay.brevo.com" SMTP_PORT="587" \
  SMTP_USER="your-smtp-user" SMTP_PASS="your-smtp-pass" \
  ALERT_FROM="Beakon Alerts <alerts@yourdomain.com>"

# 5. Deploy
fly deploy
```
Your backend is now at `https://<app>.fly.dev`. Put that in `docs/index.html`
`APP_URL` and in the Fly env `BASE_URL`.

### Option B — Render
Push the repo, then in Render: **New → Blueprint**, select the repo (it reads
`render.yaml`). Fill the `sync: false` env vars in the dashboard. Render builds
the `Dockerfile` and mounts a 1 GB disk at `/data`.

### Option C — Railway
New project → Deploy from repo → it detects the `Dockerfile`. Add a **Volume**
mounted at `/data`, set the same env vars as the Fly list above, and deploy.

---

## Stripe (same for any host)
1. Create two recurring monthly Prices (Starter $19, Agency $49); copy their
   `price_...` IDs into `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_AGENCY`.
2. Set `STRIPE_SECRET_KEY` (use `sk_test_...` while testing).
3. Add a Stripe webhook to `https://<your-backend>/webhooks/stripe` for events
   `checkout.session.completed`, `customer.subscription.created/updated/deleted`;
   put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Enable the Stripe Billing Customer Portal.

## Email
Use any SMTP provider (Brevo free = 300/day, or Resend/Mailgun). Verify a sender
and set the `SMTP_*` + `ALERT_FROM` vars. Without SMTP set, alerts print to the
logs instead of sending.

---

## Part 3 — Put the code on GitHub
```bash
cd <this repo>
git init
git add .
git commit -m "Beakon: GitHub Pages landing + deployable backend"
git branch -M main
git remote add origin https://github.com/<you>/beakon.git
git push -u origin main
```
`.gitignore` already excludes `node_modules/`, `data/`, and `.env`, so no secrets
or the database get committed.

---

## What changed vs. the Firebase version
- **No Firebase.** The app is plain Node + Express + SQLite (the `src/` code we
  built and tested first).
- **Landing** moved to `docs/` for GitHub Pages.
- **Backend** got a `Dockerfile`, `fly.toml`, and `render.yaml` so it deploys to
  any cheap host, with SQLite on a persistent `/data` volume.
- The `functions/` folder and Firebase files are now unused for this path; you
  can delete `functions/`, `firebase.json`, `.firebaserc`, `firestore.*`, and
  `public/app.html`/`public/index.html`/`public/firebase-config.js` if you want a
  clean Pages-plus-backend repo. Keep `public/landing.html` (the backend still
  references it only if you revert the `/` route) — or leave everything; unused
  files are harmless.

## Recap of the trade-off
GitHub Pages hosts the marketing page for free, exactly like your resume. The
paid app — logins, billing, and 24/7 checks — runs on a small backend for a few
dollars a month. That few dollars is what lets it actually take subscription
revenue, which pure GitHub hosting can't do.
