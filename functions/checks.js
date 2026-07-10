// functions/checks.js
// Pure check functions: HTTP/uptime, response time, and SSL certificate expiry.
// No DB or side effects — identical logic to the original, runs fine in Cloud Functions.
import tls from 'node:tls';

const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);

export function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) throw new Error('empty url');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).toString();
}

export async function httpCheck(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'BeakonMonitor/1.0 (+https://beakon.app)' },
    });
    const responseMs = Date.now() - started;
    const up = res.status >= 200 && res.status < 400;
    return { up, status: res.status, responseMs, error: up ? null : `HTTP ${res.status}` };
  } catch (err) {
    return {
      up: false,
      status: null,
      responseMs: Date.now() - started,
      error: err.name === 'AbortError' ? `Timeout after ${HTTP_TIMEOUT_MS}ms` : (err.message || 'request failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function sslCheck(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ expiresAt: null, error: 'invalid url' });
    }
    if (parsed.protocol !== 'https:') return resolve({ expiresAt: null, error: null });
    const port = parsed.port ? parseInt(parsed.port, 10) : 443;
    const socket = tls.connect(
      { host: parsed.hostname, port, servername: parsed.hostname, timeout: HTTP_TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return resolve({ expiresAt: null, error: 'no certificate' });
        resolve({ expiresAt: Math.floor(new Date(cert.valid_to).getTime() / 1000), error: null });
      }
    );
    socket.on('timeout', () => { socket.destroy(); resolve({ expiresAt: null, error: 'tls timeout' }); });
    socket.on('error', (err) => resolve({ expiresAt: null, error: err.message || 'tls error' }));
  });
}
