// src/kuma.js
// Uptime Kuma as the monitoring engine, driven over its Socket.IO API.
//
// Uptime Kuma has no REST API for monitors; its own web UI talks to the server
// over Socket.IO, and so do we. The event names and payload shapes below were
// verified against louislam/uptime-kuma:1 (see UPTIME-KUMA.md). Beakon keeps
// its own `monitors` table as the source of truth for who owns what and who
// gets told; Kuma does the checking and pushes heartbeats back here.
//
// When KUMA_URL is unset, `kuma` is null and Beakon falls back to its built-in
// checker in monitor.js, so nothing here is required to run the app.
import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';

const KUMA_URL = process.env.KUMA_URL || '';
const KUMA_USERNAME = process.env.KUMA_USERNAME || '';
const KUMA_PASSWORD = process.env.KUMA_PASSWORD || '';
const KUMA_2FA_TOKEN = process.env.KUMA_2FA_TOKEN || '';
const CALL_TIMEOUT_MS = 15000;

// Kuma heartbeat status codes.
export const KUMA_STATUS = { DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 };

export function isKumaEnabled() {
  return Boolean(KUMA_URL && KUMA_USERNAME && KUMA_PASSWORD);
}

export class KumaClient extends EventEmitter {
  constructor({ url, username, password, twoFaToken }) {
    super();
    this.url = url;
    this.username = username;
    this.password = password;
    this.twoFaToken = twoFaToken || '';
    this.socket = null;
    this.token = null;
    this.loggedIn = false;
    this.monitors = {};       // kumaId -> monitor object, as Kuma pushes it
    this.notifications = [];  // Kuma notification list
    this.lastError = null;
  }

  connect() {
    if (this.socket) return;
    this.socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    });
    const s = this.socket;
    s.on('connect', () => this.#login().catch((err) => {
      this.lastError = err.message;
      console.error('[kuma] login failed:', err.message);
    }));
    s.on('disconnect', (reason) => {
      this.loggedIn = false;
      console.warn('[kuma] disconnected:', reason);
      this.emit('disconnected', reason);
    });
    s.on('connect_error', (err) => {
      this.lastError = err.message;
      // socket.io retries on its own; log once per burst rather than every attempt.
      if (!this._loggedConnectError) {
        console.error('[kuma] connect error:', err.message);
        this._loggedConnectError = true;
        setTimeout(() => (this._loggedConnectError = false), 60000);
      }
    });
    s.on('monitorList', (list) => {
      this.monitors = list || {};
      this.emit('monitorList', this.monitors);
    });
    s.on('notificationList', (list) => {
      this.notifications = Array.isArray(list) ? list : [];
      this.emit('notificationList', this.notifications);
    });
    // Live beat: { monitorID, status, time, msg, ping, important, duration }
    s.on('heartbeat', (beat) => this.emit('heartbeat', beat));
    // On login Kuma replays recent beats per monitor; the last one is the
    // current state, which is how we resync after a restart.
    s.on('heartbeatList', (monitorID, beats) => {
      if (Array.isArray(beats) && beats.length) {
        const last = beats[beats.length - 1];
        this.emit('heartbeat', { ...last, monitorID: last.monitorID ?? last.monitor_id ?? monitorID, replay: true });
      }
    });
    // certInfo is (monitorID, JSON string) -> { valid, certInfo: { validTo, daysRemaining, ... } }
    s.on('certInfo', (monitorID, json) => {
      try {
        const info = typeof json === 'string' ? JSON.parse(json) : json;
        this.emit('certInfo', { monitorID: Number(monitorID), info });
      } catch { /* ignore malformed */ }
    });
  }

  async #login() {
    // Prefer the JWT from a previous login so a reconnect doesn't hit the
    // login rate limiter.
    if (this.token) {
      const r = await this.#raw('loginByToken', this.token);
      if (r && r.ok) return this.#afterLogin();
      this.token = null;
    }
    const r = await this.#raw('login', { username: this.username, password: this.password, token: this.twoFaToken });
    if (!r || !r.ok) throw new Error(r?.msg || (r?.tokenRequired ? '2FA token required (set KUMA_2FA_TOKEN)' : 'login rejected'));
    this.token = r.token;
    this.#afterLogin();
  }

  #afterLogin() {
    this.loggedIn = true;
    this.lastError = null;
    console.log('[kuma] logged in to', this.url);
    this.emit('ready');
  }

  #raw(event, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) return reject(new Error('kuma not connected'));
      const timer = setTimeout(() => reject(new Error(`kuma call ${event} timed out`)), CALL_TIMEOUT_MS);
      this.socket.emit(event, ...args, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  /** Call a Kuma socket event and throw unless it replied { ok: true }. */
  async call(event, ...args) {
    if (!this.loggedIn) throw new Error('kuma not logged in');
    const res = await this.#raw(event, ...args);
    if (!res || res.ok === false) throw new Error(res?.msg || `kuma ${event} failed`);
    return res;
  }

  isReady() { return Boolean(this.socket?.connected && this.loggedIn); }

  async addMonitor(spec) {
    const r = await this.call('add', spec);
    return r.monitorID;
  }
  async editMonitor(spec) {
    return this.call('editMonitor', spec);
  }
  async getMonitor(id) {
    const r = await this.call('getMonitor', Number(id));
    return r.monitor;
  }
  async deleteMonitor(id) {
    return this.call('deleteMonitor', Number(id));
  }
  async pauseMonitor(id) {
    return this.call('pauseMonitor', Number(id));
  }
  async resumeMonitor(id) {
    return this.call('resumeMonitor', Number(id));
  }
  async getBeats(id, hours = 24) {
    const r = await this.call('getMonitorBeats', Number(id), hours);
    return r.data || [];
  }
  /** Kuma notification channels (SMTP, Slack, Telegram, ... configured in Kuma's UI). */
  listNotifications() {
    return this.notifications.map((n) => ({ id: n.id, name: n.name, type: n.type, active: n.active !== false }));
  }
  async addNotification(notification) {
    const r = await this.call('addNotification', notification, null);
    return r.id;
  }
  async deleteNotification(id) {
    return this.call('deleteNotification', Number(id));
  }
  async testNotification(notification) {
    return this.call('testNotification', notification);
  }
}

/**
 * Build the Kuma monitor object for one Beakon monitor row. `notificationIds`
 * are the Kuma notification ids to attach (from the client's alert channel).
 */
export function toKumaSpec(m, notificationIds = []) {
  const interval = Math.max(20, Number(m.interval_seconds) || 60);
  const notificationIDList = {};
  for (const id of notificationIds) if (id) notificationIDList[id] = true;
  const base = {
    name: m.name,
    // Lets an operator looking at Kuma's own UI trace a monitor back here, and
    // lets Beakon recognise its own monitors on reconcile.
    description: `beakon:${m.id}`,
    interval,
    retryInterval: interval,
    // One retry before declaring DOWN: Kuma reports PENDING in between, which
    // filters out single-packet blips without hiding a real outage.
    maxretries: 1,
    resendInterval: 0,
    notificationIDList,
    expiryNotification: true,
    ignoreTls: false,
    upsideDown: false,
    maxredirects: 10,
    accepted_statuscodes: ['200-299', '300-399'],
    method: 'GET',
    active: true,
  };
  if (m.kuma_monitor_id) base.id = m.kuma_monitor_id;

  switch (m.type) {
    case 'keyword':
      return { ...base, type: 'keyword', url: m.url, keyword: m.keyword || '', invertKeyword: false };
    case 'ping':
      return { ...base, type: 'ping', hostname: m.hostname || hostOf(m.url) };
    case 'port':
      return { ...base, type: 'port', hostname: m.hostname || hostOf(m.url), port: Number(m.port) || 443 };
    case 'dns':
      return {
        ...base, type: 'dns', hostname: m.hostname || hostOf(m.url),
        dns_resolve_server: '1.1.1.1', dns_resolve_type: 'A', port: 53,
      };
    case 'http':
    default:
      return { ...base, type: 'http', url: m.url };
  }
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

/** Monitor types Beakon exposes; Kuma-only types are hidden when Kuma is off. */
export const MONITOR_TYPES = [
  { key: 'http', label: 'HTTP(S) uptime', builtin: true },
  { key: 'keyword', label: 'HTTP + keyword', builtin: true },
  { key: 'ping', label: 'Ping (ICMP)', builtin: false },
  { key: 'port', label: 'TCP port', builtin: false },
  { key: 'dns', label: 'DNS resolves', builtin: false },
];

export function availableMonitorTypes() {
  return isKumaEnabled() ? MONITOR_TYPES : MONITOR_TYPES.filter((t) => t.builtin);
}

export const kuma = isKumaEnabled()
  ? new KumaClient({ url: KUMA_URL, username: KUMA_USERNAME, password: KUMA_PASSWORD, twoFaToken: KUMA_2FA_TOKEN })
  : null;
