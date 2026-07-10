# Beakon

**Know before your clients do.** Uptime, response-time, and SSL-expiry monitoring built for agencies and freelancers who manage lots of client websites.

- 1-minute uptime checks (HTTP/HTTPS)
- SSL certificate expiry warnings (default: 14 days out)
- Email alerts on down / recovered / cert-expiring
- Multi-site dashboard, per-account monitor limits
- Stripe subscriptions (Starter $19/mo, Agency $49/mo) with a 14-day free trial
- Single Node.js process + SQLite. Runs comfortably on the smallest DigitalOcean droplet.

---

## Tech overview

| Piece | What it is |
|---|---|
| `src/server.js` | Express app: auth, dashboard, monitor CRUD, Stripe checkout + webhook |
| `src/monitor.js` | Background scheduler that sweeps active monitors and fires alerts |
| `src/checks.js` | Pure HTTP + SSL check functions (no side effects, easy to test) |
| `src/db.js` | SQLite layer. Uses `better-sqlite3` if installed, else Node's built-in `node:sqlite` |
| `src/plans.js` | Plan limits + account-active logic |
| `src/mailer.js` | SMTP alerts via nodemailer (logs to console if SMTP unset) |
| `public/landing.html` | Marketing landing page served at `/` |

**No native build required.** `better-sqlite3` is an *optional* dependency. If it builds, Beakon uses it; if not, it falls back to the SQLite engine built into Node 18.5+/20/22. Either way it just works.

---

## Run locally

```bash
npm install
cp .env.example .env        # then edit .env
npm start                   # http://localhost:3000
```

Without SMTP configured, alert emails are printed to the console so you can develop without a mail provider.

---

## Deploy to DigitalOcean (cheapest path: one droplet)

### 1. Create the droplet
- Create a **Basic / Regular, $6/mo** droplet, Ubuntu 24.04 LTS.
- Add your SSH key. SSH in: `ssh root@YOUR_DROPLET_IP`

### 2. Install Node + git
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git build-essential python3
```
(`build-essential python3` let `better-sqlite3` compile for best performance; optional — Beakon runs without them.)

### 3. Get the code
```bash
git clone YOUR_REPO_URL /opt/beakon   # or scp the folder up
cd /opt/beakon
npm install
cp .env.example .env
nano .env                              # fill in the values (see below)
```

### 4. Fill in `.env`
- `BASE_URL` — your public URL, e.g. `https://app.yourdomain.com`
- `SESSION_SECRET` — run `openssl rand -hex 32` and paste it
- **SMTP** — sign up for a free sender (Brevo gives 300 emails/day free; Resend and Mailgun also have free tiers). Paste host/port/user/pass and a verified `ALERT_FROM` address.
- **Stripe** — see the Stripe section below.

### 5. Run it under a process manager
```bash
npm install -g pm2
pm2 start src/server.js --name beakon
pm2 save
pm2 startup            # run the command it prints, so Beakon restarts on reboot
```

### 6. Put Nginx + HTTPS in front
```bash
apt-get install -y nginx certbot python3-certbot-nginx
```
Create `/etc/nginx/sites-available/beakon`:
```nginx
server {
  server_name app.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
```bash
ln -s /etc/nginx/sites-available/beakon /etc/nginx/sites-enabled/beakon
nginx -t && systemctl reload nginx
certbot --nginx -d app.yourdomain.com      # free HTTPS, auto-renews
```
Point an `A` record for `app.yourdomain.com` at the droplet IP first.

> Because the app sets secure cookies in production, you **must** serve it over HTTPS (the Nginx + certbot step) or logins won't stick.

---

## Stripe setup

1. In the Stripe Dashboard, create two **recurring monthly Products/Prices**: Starter ($19) and Agency ($49). Copy each `price_...` ID into `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_AGENCY`.
2. Copy your secret key into `STRIPE_SECRET_KEY` (use `sk_test_...` while testing).
3. Create a webhook endpoint pointing at `https://app.yourdomain.com/webhooks/stripe`, subscribed to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Enable the **Billing Customer Portal** in Stripe settings so the "Manage / cancel subscription" button works.
5. Restart: `pm2 restart beakon`.

To test the money path before launch, use Stripe **test mode** + the Stripe CLI (`stripe listen --forward-to localhost:3000/webhooks/stripe`) and card `4242 4242 4242 4242`.

---

## Operating notes
- Logs: `pm2 logs beakon`
- The SQLite database lives in `data/beakon.db` (git-ignored). Back it up with a daily `cp` to DigitalOcean Spaces or a cron `scp`.
- One droplet handles hundreds of monitors fine. If you outgrow it, move checks to a worker process and the DB to managed Postgres.
- Default check cadence is every 60s for every active monitor (`CHECK_INTERVAL_SECONDS`).

## Roadmap ideas (post-launch, in priority order)
1. SMS/Slack/Discord alerts (agencies love Slack alerts — easy upsell).
2. Public status pages per client (great word-of-mouth driver).
3. Domain/WHOIS expiry checks (you already alert on SSL; domains are the natural next one).
4. Multi-user / team seats for bigger agencies.
