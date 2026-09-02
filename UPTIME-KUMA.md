# Beakon as the client-facing face of Uptime Kuma

Beakon is the **admin interface for everything client-facing**: who a client
is, which sites roll up into them, who may sign in, where alerts go, and what
the customer is (not) charged for. **Uptime Kuma** is the engine underneath:
it runs the checks (HTTP, keyword, ping, TCP port, DNS — and anything else it
grows) and pushes heartbeats back. Customers only ever see up/down in Beakon;
the operator sees everything, in Beakon's admin console and in Kuma's own UI.

```
 marketingCRM ──onboard──▶  Beakon (Express + SQLite, Fly)  ◀──Google sign-in── customer / admin
   ▲  signals                 │  ▲                            (Firebase project marketingcrm-c5d57)
   └──────────────────────────┘  │ heartbeats, certInfo
                                 ▼ add / edit / pause / delete (Socket.IO)
                         Uptime Kuma (Fly, private network)
```

## What changed in Beakon

| Concern | Before | Now |
|---|---|---|
| Identity | email + password per app | **Google via Firebase** (`marketingcrm-c5d57`), same account as the CRM portal. The CRM's `admin` custom claim (or `ADMIN_EMAILS`) makes an admin. Password login stays available as a fallback (`LEGACY_PASSWORD_LOGIN`). |
| Grouping | monitors belonged to a user | **Clients** group monitors. One alert address, one alert type, one on/off switch per client. A person can access several clients; admins see all. |
| Who pays | every monitor counted | `monitors.source` = `user` (counts against the plan) / `admin` / `crm` (**free**, shown as INCLUDED). Free monitors keep running even if the customer's trial lapses. |
| Alerts | always emailed | **Alert type dropdown**: Disabled / Email / (admin) any Uptime Kuma notification channel. Blank address = off, silently. A new address gets **one** confirmation email and nothing is sent until the link is clicked. |
| Enable/disable | delete only | Per-monitor **Enable/Disable** (pauses the Kuma twin) and per-client **Alerts on/off**. |
| Engine | built-in HTTP + SSL sweeper | **Uptime Kuma** when `KUMA_URL` is set; built-in sweeper otherwise (or for anything not yet mirrored). |
| CRM | one-way (documented, not wired) | Two-way: CRM onboarding **creates the client and monitors** here; Beakon posts **down / recovered / cert** signals back. |

## The Socket.IO contract (verified against `louislam/uptime-kuma:1`)

Kuma has no REST API for monitors; its UI speaks Socket.IO and so does
`src/kuma.js` (`socket.io-client`). Every call is `socket.emit(event, ...args, callback)`
and the callback receives `{ ok, msg, ... }`.

| Direction | Event | Payload / reply |
|---|---|---|
| → | `needSetup` | reply `true` when no user exists; then `setup(username, password)` |
| → | `login` `{ username, password, token }` | `{ ok, token }` (JWT) — `{ tokenRequired: true }` if 2FA |
| → | `loginByToken` `jwt` | `{ ok }` — used on reconnect so the login rate-limiter is never hit |
| → | `add` monitor | `{ ok, monitorID }` |
| → | `editMonitor` monitor (with `id`) | `{ ok, monitorID }` |
| → | `pauseMonitor` / `resumeMonitor` / `deleteMonitor` `id` | `{ ok }` |
| → | `getMonitor` `id` | `{ ok, monitor }` |
| → | `getMonitorBeats` `id, hours` | `{ ok, data: beat[] }` |
| → | `addNotification` notification, `null` | `{ ok, id }` · `deleteNotification id` · `testNotification` |
| ← | `monitorList` | `{ [id]: monitor }` — pushed after login and after every change |
| ← | `notificationList` | `notification[]` — what the admin's alert dropdown offers |
| ← | `heartbeat` | `{ monitorID, status, time, msg, ping, important, duration }` — `status` 0 DOWN · 1 UP · 2 PENDING · 3 MAINTENANCE |
| ← | `heartbeatList` `(monitorID, beats[])` | replayed on login; the last beat is current state |
| ← | `certInfo` `(monitorID, json)` | `{ valid, certInfo: { validTo, daysRemaining, … } }` |

Monitor fields Beakon sends (`toKumaSpec`): `type`, `name`, `description`
(`beakon:<id>` — how a monitor is traced back), `url` / `hostname` / `port` /
`keyword`, `interval`, `retryInterval`, `maxretries: 1` (one retry → PENDING
before DOWN, which swallows single-packet blips), `accepted_statuscodes`,
`expiryNotification`, `notificationIDList: { [kumaNotificationId]: true }`.

## How the pieces talk

- **Beakon's `monitors` table is the source of truth.** Each row has a
  `kuma_monitor_id`. `reconcileKuma()` runs on connect and every fifth sweep:
  it creates missing twins, pauses/resumes to match `active` and billing, and
  lists monitors that exist only in Kuma so the admin can **import** them into a
  client (they become `source=admin`, free).
- **Heartbeats → `engine.js`.** `applyObservation()` is the only place that
  decides "this is a transition": it logs the event, emails (if the client's
  alert mode is a verified email), and posts a CRM signal. The built-in sweeper
  feeds the same function, so Kuma-on and Kuma-off behave identically.
- **Alert type = Kuma channel.** Choosing an Uptime Kuma notification in the
  dropdown attaches it to all of that client's Kuma monitors
  (`notificationIDList`); Kuma then delivers Slack/Telegram/SMS/whatever it is.
  Beakon records `alert_kuma` events but sends nothing itself. Choosing Email
  means Beakon sends, and only to a confirmed address.
- **SSL.** Kuma's `certInfo` gives `validTo`; Beakon stores it and warns at
  `SSL_WARN_DAYS`, at most once a day, as `cert_expiring` / `cert_expired`.

## Deploy Uptime Kuma (Fly, private)

```bash
fly apps create beakon-kuma
fly volumes create kuma_data --region ams --size 1 -a beakon-kuma
fly deploy -c infra/kuma/fly.toml -a beakon-kuma
fly proxy 3001:3001 -a beakon-kuma       # open http://localhost:3001, create the admin user once
fly secrets set KUMA_URL=http://beakon-kuma.internal:3001 KUMA_USERNAME=beakon KUMA_PASSWORD='…' -a beakon
```

Leave 2FA off for the account Beakon uses (or supply `KUMA_2FA_TOKEN`, which
is a moving target). Kuma stays private on the 6PN network; use `fly proxy`
when you want its UI. Set up your own operator channels (Slack, Telegram,
SMTP…) in that UI and they appear in Beakon's admin alert dropdown.

Locally: `docker run -d -p 3001:3001 louislam/uptime-kuma:1`, set
`KUMA_URL=http://localhost:3001` and the credentials you create on first open.

## Identity: one Google account, both apps

Beakon verifies Firebase ID tokens against the CRM's project. Set:

```
FIREBASE_SERVICE_ACCOUNT_JSON=…   # the same secret the CRM API holds
FIREBASE_WEB_API_KEY / FIREBASE_WEB_AUTH_DOMAIN / FIREBASE_WEB_PROJECT_ID / FIREBASE_WEB_APP_ID
```

and add Beakon's domain (`beakon.fly.dev` or your custom domain) to
**Firebase console → Authentication → Settings → Authorized domains**. Admin =
the `admin` custom claim the CRM's `npm run set-admin -- --email=…` sets, or an
address in `ADMIN_EMAILS`. Customers are matched to clients by email
(`client_users`), so access can be granted before they have ever signed in.

## CRM onboarding → Beakon

The CRM calls (see `apps/api/src/beakon.ts` there):

```
POST {BEAKON}/api/crm/clients
Authorization: Bearer $CRM_WEBHOOK_TOKEN
{ "slug": "carols-table", "name": "Carol's Table", "crmClientId": 7,
  "domain": "carolstable.com", "owners": ["carol@example.com"],
  "alertEmail": "carol@example.com",
  "sites": [{ "name": "Carol's Table", "url": "https://carolstable.com" }] }
```

Idempotent on `slug`: re-running updates the name, grants any new owner,
adds monitors for new sites, and never duplicates. Monitors are `source=crm`
(free). `alertEmail` is only applied when the client has no address yet, and
the confirmation email still has to be clicked. The reply carries
`dashboardUrl`. `GET /api/crm/clients/:slug` returns live status for the CRM.

Beakon → CRM signals (`POST /api/signals`, `CRM_SIGNAL_TOKEN`) fire on
transitions only: `down` (with a second, `durationMinutes ≥ 240` signal once
an outage passes four hours, which is the CRM's pitch threshold), `recovered`,
`cert_expiring`, `cert_expired`.

## Files

| File | Role |
|---|---|
| `src/kuma.js` | Socket.IO client, monitor spec builder, monitor types |
| `src/engine.js` | observations → transitions → events, alerts, CRM signals |
| `src/monitor.js` | built-in sweeper + Kuma event wiring + reconcile cadence |
| `src/monitors.js` | monitor CRUD, Kuma mirroring, import of Kuma-only monitors |
| `src/clients.js` | clients, access grants, alert settings + email confirmation |
| `src/auth.js` | Firebase ID-token verification, admin rule, session helpers |
| `src/crm.js` | outbound signals, inbound onboarding webhook |
| `src/views.js` | customer dashboard, admin console, sign-in page |
| `infra/kuma/fly.toml` | Uptime Kuma on Fly |
