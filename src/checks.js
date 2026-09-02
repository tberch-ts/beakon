// src/checks.js
// Pure check functions: HTTP/uptime, response time, and SSL certificate expiry.
// No DB or email side effects here so they are easy to test in isolation.
import tls from 'node:tls';

const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);

/**
 * Normalise a user-entered URL into something fetchable.
 * Accepts "example.com", "http://example.com", "https://example.com/path".
 */
export function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) throw new Error('empty url');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  // Throws if invalid.
  const parsed = new URL(u);
  return parsed.toString();
}

/**
 * Perform an HTTP(S) uptime check, optionally requiring a keyword in the body.
 * Returns { up, status, responseMs, error }.
 */
export async function httpCheck(url, { keyword = null } = {}) {
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
    // 2xx and 3xx are considered "up". 4xx/5xx are "down".
    let up = res.status >= 200 && res.status < 400;
    let error = up ? null : `HTTP ${res.status}`;
    // Keyword monitors also require the body to contain the phrase.
    if (up && keyword) {
      const body = await res.text().catch(() => '');
      if (!body.toLowerCase().includes(String(keyword).toLowerCase())) {
        up = false;
        error = `keyword "${keyword}" not found`;
      }
    }
    const responseMs = Date.now() - started;
    return { up, status: res.status, responseMs, error };
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

/**
 * Read the TLS certificate for an https URL and return its expiry (epoch seconds).
 * Returns { expiresAt, error }. Skipped for http URLs (expiresAt null, no error).
 */
export function sslCheck(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ expiresAt: null, error: 'invalid url' });
    }
    if (parsed.protocol !== 'https:') {
      return resolve({ expiresAt: null, error: null }); // nothing to check
    }
    const port = parsed.port ? parseInt(parsed.port, 10) : 443;
    const socket = tls.connect(
      { host: parsed.hostname, port, servername: parsed.hostname, timeout: HTTP_TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          return resolve({ expiresAt: null, error: 'no certificate' });
        }
        const expiresAt = Math.floor(new Date(cert.valid_to).getTime() / 1000);
        resolve({ expiresAt, error: null });
      }
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ expiresAt: null, error: 'tls timeout' });
    });
    socket.on('error', (err) => {
      resolve({ expiresAt: null, error: err.message || 'tls error' });
    });
  });
}
