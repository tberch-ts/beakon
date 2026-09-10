// src/search.js
// The Search Ladder analyzer: fetch what Google would fetch, run the ladder's
// automated checks against it, merge in the client's attestations, and store
// the graded result. The ladder itself (which checks belong to which rung, and
// what a failing one means) is searchLadder.js; this file only knows how to
// look at a website.
//
// Everything here is plain fetch + regex on purpose. The checks are the same
// ones a person does by hand with "view source" and /robots.txt, and a real
// HTML parser would not make "is there exactly one <h1>" any more true. Body
// reads are capped so a 40 MB homepage cannot pin the process.
//
// A client may have several sites. Each site root is graded on its own; the
// client's headline grade is the primary domain's. See SEARCH-LADDER.md,
// "Clients with more than one site".
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { normalizeUrl } from './checks.js';
import { getClient } from './clients.js';
import { listMonitorsForClient } from './monitors.js';
import { RUNGS, CHECKS, ATTESTATIONS, grade as gradeLadder } from './searchLadder.js';

const TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);
const MAX_BODY = 1_500_000;
const SAMPLE_PAGES = 10;      // sitemap URLs fetched with bodies, beyond the homepage
const MAX_SITES_PER_CLIENT = 5;
const UA = 'BeakonSearch/1.0 (+https://beakon.app; search-ladder)';

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** GET a URL and return { ok, status, finalUrl, headers, body, ms, error }. */
export async function fetchPage(url, { body = true } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5' },
    });
    let text = '';
    if (body) {
      // Read at most MAX_BODY bytes, then stop pulling.
      const reader = res.body?.getReader();
      if (reader) {
        const chunks = [];
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
          if (total >= MAX_BODY) { await reader.cancel().catch(() => {}); break; }
        }
        text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    const headers = {};
    for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, finalUrl: res.url || url, headers, body: text, ms: Date.now() - started, error: null };
  } catch (err) {
    const error = err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : (err.cause?.code || err.message || 'request failed');
    return { ok: false, status: null, finalUrl: url, headers: {}, body: '', ms: Date.now() - started, error };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// HTML reading
// ---------------------------------------------------------------------------

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4]) : null;
}

function tags(html, name) {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
}

/** Pull the facts the checks need out of one HTML document. */
export function readHtml(html, pageUrl) {
  const head = html.slice(0, 400_000);
  const metas = tags(head, 'meta').map((t) => ({ name: (attr(t, 'name') || attr(t, 'property') || attr(t, 'http-equiv') || '').toLowerCase(), content: attr(t, 'content') }));
  const meta = (n) => metas.find((m) => m.name === n)?.content ?? null;
  const links = tags(head, 'link');
  const canonical = links.filter((t) => /\brel\s*=\s*["']?canonical/i.test(t)).map((t) => attr(t, 'href')).filter(Boolean);
  const titleM = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || '';
  const h1s = (html.match(/<h1\b[^>]*>/gi) || []).length;
  const jsonld = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonld.push(JSON.parse(m[1].trim())); } catch { /* malformed block: ignore, the check will fail on its own */ }
  }
  const anchors = [];
  for (const t of tags(html, 'a')) {
    const href = attr(t, 'href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try { anchors.push(new URL(href, pageUrl).toString()); } catch { /* skip */ }
  }
  const scripts = tags(html, 'script').map((t) => attr(t, 'src')).filter(Boolean);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return {
    url: pageUrl,
    title: titleM ? decode(titleM[1].replace(/\s+/g, ' ')) : null,
    description: meta('description'),
    robots: meta('robots'),
    viewport: meta('viewport'),
    lang: attr(htmlTag, 'lang'),
    canonical,
    h1Count: h1s,
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image') },
    jsonld,
    anchors,
    scripts,
    hasTelLink: /href\s*=\s*["']tel:/i.test(html),
    hasAddressTag: /<address\b/i.test(html),
    text,
    inlineScript: (html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || []).join('\n').slice(0, 200_000),
  };
}

/** Flatten JSON-LD (including @graph and arrays) into a list of typed nodes. */
function jsonldNodes(blocks) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n['@type']) out.push(n);
    if (n['@graph']) walk(n['@graph']);
    for (const k of Object.keys(n)) if (k !== '@graph' && typeof n[k] === 'object') walk(n[k]);
  };
  walk(blocks);
  return out;
}

const BUSINESS_TYPE = /^(Organization|Corporation|LocalBusiness|Store|Restaurant|BarOrPub|Bakery|CafeOrCoffeeShop|HairSalon|BeautySalon|NailSalon|DaySpa|HealthAndBeautyBusiness|Dentist|Physician|MedicalBusiness|MedicalClinic|Attorney|LegalService|AutoRepair|AutomotiveBusiness|Plumber|Electrician|HVACBusiness|HomeAndConstructionBusiness|GeneralContractor|RoofingContractor|Locksmith|MovingCompany|ProfessionalService|FinancialService|AccountingService|InsuranceAgency|RealEstateAgent|TravelAgency|LodgingBusiness|Hotel|FoodEstablishment|EntertainmentBusiness|NightClub|SportsActivityLocation|ExerciseGym|ChildCare|EducationalOrganization|School|Church|PlaceOfWorship|GovernmentOrganization|NGO|Florist|PetStore|VeterinaryCare|AnimalShelter|Winery|Brewery|Distillery|TattooParlor|DryCleaningOrLaundry|SelfStorage|ShoppingCenter|GroceryStore|ClothingStore|FurnitureStore|HardwareStore|JewelryStore|ElectronicsStore|BookStore|Pharmacy|Hospital|Library|Museum|RadioStation|TelevisionStation|PerformingGroup|MusicGroup|SportsTeam|EmploymentAgency|InternetCafe|MusicVenue|EventVenue)$/;

function businessNodes(pages) {
  const found = [];
  for (const p of pages) {
    for (const n of jsonldNodes(p.jsonld)) {
      const types = [].concat(n['@type']).map(String);
      if (types.some((t) => BUSINESS_TYPE.test(t) || /Business|Store|Shop|Service$/.test(t))) found.push({ page: p.url, node: n, types });
    }
  }
  return found;
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const STREET_RE = /\b\d{1,6}\s+(?:[A-Z][a-zA-Z.]*\s){1,4}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Ct|Court|Pl(?:ace)?|Hwy|Highway|Pkwy|Parkway|Ter(?:race)?|Cir(?:cle)?|Sq(?:uare)?)\b\.?/;

// ---------------------------------------------------------------------------
// robots.txt and sitemaps
// ---------------------------------------------------------------------------

/** Parse robots.txt into { groups: [{ agents, allow, disallow }], sitemaps } */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow') cur.allow.push(val);
    if (key === 'disallow') cur.disallow.push(val);
  }
  return { groups, sitemaps };
}

/** Is the whole site blocked for this agent (a bare "Disallow: /" with no matching Allow: /)? */
export function robotsBlocksAll(robots, agent = 'googlebot') {
  const specific = robots.groups.filter((g) => g.agents.includes(agent));
  const wild = robots.groups.filter((g) => g.agents.includes('*'));
  const applicable = specific.length ? specific : wild;
  if (!applicable.length) return false;
  const disallowAll = applicable.some((g) => g.disallow.some((d) => d === '/' || d === '/*'));
  const allowAll = applicable.some((g) => g.allow.some((a) => a === '/' || a === '/*'));
  return disallowAll && !allowAll;
}

function parseSitemap(xml) {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
  const lastmods = [...xml.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/gi)].map((m) => m[1]);
  return { isIndex, locs, lastmods, valid: (/<urlset\b/i.test(xml) || isIndex) && locs.length > 0 };
}

async function loadSitemap(origin, robots) {
  const candidates = [...robots.sitemaps];
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']) candidates.push(origin + p);
  const tried = [];
  for (const cand of [...new Set(candidates)]) {
    let url;
    try { url = new URL(cand, origin).toString(); } catch { continue; }
    const res = await fetchPage(url);
    tried.push({ url, status: res.status ?? res.error });
    if (!res.ok) continue;
    const parsed = parseSitemap(res.body);
    if (!parsed.valid) continue;
    let urls = parsed.locs;
    let lastmods = parsed.lastmods;
    const children = [];
    if (parsed.isIndex) {
      urls = [];
      lastmods = [];
      for (const child of parsed.locs.slice(0, 3)) {
        const c = await fetchPage(child);
        children.push({ url: child, status: c.status ?? c.error });
        if (!c.ok) continue;
        const cp = parseSitemap(c.body);
        if (cp.valid && !cp.isIndex) { urls.push(...cp.locs); lastmods.push(...cp.lastmods); }
      }
    }
    return { url, isIndex: parsed.isIndex, children, urls: [...new Set(urls)].slice(0, 500), lastmods, tried, fromRobots: robots.sitemaps.length > 0 && robots.sitemaps.some((s) => { try { return new URL(s, origin).toString() === url; } catch { return false; } }) };
  }
  return { url: null, urls: [], lastmods: [], tried, fromRobots: false };
}

// ---------------------------------------------------------------------------
// Google Business Profile lookup (optional; needs GOOGLE_PLACES_API_KEY)
// ---------------------------------------------------------------------------

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
export const isPlacesConfigured = () => Boolean(PLACES_KEY);

/**
 * Find the profile for a business by name and confirm it points at this host.
 * Uses Places API (New) Text Search. Returns { placeId, website, name } or null.
 */
export async function findPlaceForBusiness(name, host, hint = '') {
  if (!PLACES_KEY || !name) return null;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.websiteUri,places.formattedAddress' },
      body: JSON.stringify({ textQuery: hint ? `${name} ${hint}` : name, maxResultCount: 5 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
    for (const p of data.places || []) {
      let siteHost = '';
      try { siteHost = bare(new URL(p.websiteUri).hostname); } catch { /* no website on the profile */ }
      if (siteHost && siteHost === bare(host)) return { placeId: p.id, website: p.websiteUri, name: p.displayName?.text || name, address: p.formattedAddress || null };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The analysis of one site
// ---------------------------------------------------------------------------

const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });
const short = (urls, n = 3) => urls.slice(0, n).map((u) => u.replace(/^https?:\/\/[^/]+/, '') || '/').join(', ') + (urls.length > n ? ` +${urls.length - n} more` : '');

/**
 * Run every automated check against one site. `domain` may be a bare host or a
 * URL. Returns { domain, origin, checks: { id: { ok, detail } }, pages, sitemap, ms }.
 */
export async function analyzeSite(domain, { placeId = null, businessName = null } = {}) {
  const started = Date.now();
  const checks = {};
  const startUrl = normalizeUrl(domain);
  const inputHost = new URL(startUrl).hostname.toLowerCase();

  // ---- Rung 2: reachable, one host, indexable
  const home = await fetchPage(startUrl);
  let origin = null;
  let host = inputHost;
  if (home.ok && /^https:/i.test(home.finalUrl)) {
    const u = new URL(home.finalUrl);
    origin = u.origin;
    host = u.hostname.toLowerCase();
    checks.https_ok = pass(`${home.status} in ${home.ms} ms at ${home.finalUrl}`);
  } else {
    checks.https_ok = fail(home.error ? `${startUrl}: ${home.error}` : `${home.finalUrl}: HTTP ${home.status}${/^http:/i.test(home.finalUrl) ? ' (ended on http://)' : ''}`);
  }

  if (!origin) {
    // Nothing else can be checked without a homepage; mark every other check as failed with the reason.
    for (const id of Object.keys(CHECKS)) if (!checks[id]) checks[id] = fail('homepage unreachable');
    checks.gbp_listed = placeId ? pass(`Place ID ${placeId}`) : fail('no Place ID on record');
    return { domain: inputHost, origin: null, checks, pages: [], sitemap: null, home: { status: home.status, error: home.error }, ms: Date.now() - started };
  }

  const bareHost = host.replace(/^www\./, '');
  const variants = [`http://${host}/`, host.startsWith('www.') ? `https://${bareHost}/` : `https://www.${bareHost}/`];
  const variantResults = await mapLimit(variants, 2, (v) => fetchPage(v, { body: false }));
  const stray = [];
  variants.forEach((v, i) => {
    const r = variantResults[i];
    if (r.error && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(r.error)) return; // hostname does not exist: not a duplicate
    if (r.error) { stray.push(`${v} → ${r.error}`); return; }
    let fh = '';
    try { fh = new URL(r.finalUrl).host.toLowerCase(); } catch { /* ignore */ }
    if (fh !== host || !/^https:/i.test(r.finalUrl)) stray.push(`${v} → ${r.finalUrl} (${r.status})`);
  });
  checks.single_host = stray.length ? fail(stray.join('; ')) : pass(`everything lands on https://${host}/`);

  const homeDoc = readHtml(home.body, home.finalUrl);
  const xRobots = home.headers['x-robots-tag'] || '';
  const noindex = /noindex/i.test(homeDoc.robots || '') || /noindex/i.test(xRobots);
  checks.indexable = noindex ? fail(`noindex via ${/noindex/i.test(xRobots) ? 'X-Robots-Tag header' : 'robots meta'}`) : pass(homeDoc.robots ? `robots meta: ${homeDoc.robots}` : 'no noindex directive');

  // ---- Rung 3: robots, sitemap, canonical
  const robotsRes = await fetchPage(origin + '/robots.txt');
  let robots = { groups: [], sitemaps: [] };
  if (robotsRes.ok && /text\/plain|text\/|octet/i.test(robotsRes.headers['content-type'] || 'text/plain')) {
    robots = parseRobots(robotsRes.body);
    checks.robots_txt = robotsBlocksAll(robots) ? fail('Disallow: / applies to Googlebot') : pass(`${robots.groups.length} group(s), ${robots.sitemaps.length} sitemap line(s)`);
  } else if (robotsRes.status === 404) {
    checks.robots_txt = pass('no robots.txt (crawl allowed by default) — add one so the sitemap can be declared');
  } else {
    checks.robots_txt = fail(robotsRes.error || `HTTP ${robotsRes.status}`);
  }

  const sitemap = await loadSitemap(origin, robots);
  if (sitemap.url) {
    checks.sitemap_found = pass(`${sitemap.urls.length} URL(s) in ${sitemap.url.replace(origin, '')}${sitemap.isIndex ? ' (index)' : ''}`);
    checks.sitemap_in_robots = sitemap.fromRobots ? pass('declared in robots.txt') : fail(`robots.txt has no Sitemap: line for ${sitemap.url}`);
  } else {
    checks.sitemap_found = fail(`tried ${sitemap.tried.map((t) => `${t.url.replace(origin, '')} (${t.status})`).join(', ')}`);
    checks.sitemap_in_robots = fail('no sitemap to declare');
  }

  const offHost = sitemap.urls.filter((u) => { try { return new URL(u).host.toLowerCase() !== host; } catch { return true; } });
  const sameHost = sitemap.urls.filter((u) => !offHost.includes(u));
  const sampleUrls = sameHost.filter((u) => u.replace(/\/$/, '') !== home.finalUrl.replace(/\/$/, '')).slice(0, SAMPLE_PAGES);
  const sampled = await mapLimit(sampleUrls, 4, (u) => fetchPage(u));
  const pages = [homeDoc];
  const badUrls = [];
  sampleUrls.forEach((u, i) => {
    const r = sampled[i];
    const redirected = r.finalUrl.replace(/\/$/, '') !== u.replace(/\/$/, '');
    if (!r.ok || redirected) badUrls.push(`${u.replace(origin, '')} (${r.status ?? r.error}${redirected && r.ok ? ` → ${r.finalUrl.replace(origin, '')}` : ''})`);
    else if (/text\/html/i.test(r.headers['content-type'] || '')) pages.push(readHtml(r.body, r.finalUrl));
  });
  if (!sitemap.url) checks.sitemap_urls_ok = fail('no sitemap');
  else if (offHost.length) checks.sitemap_urls_ok = fail(`${offHost.length} URL(s) on another host: ${short(offHost)}`);
  else if (badUrls.length) checks.sitemap_urls_ok = fail(`${badUrls.length} of ${sampleUrls.length} sampled failed: ${badUrls.slice(0, 3).join('; ')}`);
  else checks.sitemap_urls_ok = pass(`${sampleUrls.length} sampled, all 200 on ${host}`);

  const noCanon = pages.filter((p) => !p.canonical.some((c) => { try { const cu = new URL(c, p.url); return cu.protocol === 'https:' && cu.host.toLowerCase() === host; } catch { return false; } }));
  checks.canonical_present = noCanon.length ? fail(`missing or off-host on ${noCanon.length}/${pages.length}: ${short(noCanon.map((p) => p.url))}`) : pass(`present on all ${pages.length} page(s) checked`);

  // ---- Rung 4: on-page basics (every sampled page)
  const per = (id, test, label) => {
    const bad = pages.filter((p) => !test(p));
    checks[id] = bad.length ? fail(`${label} on ${bad.length}/${pages.length}: ${short(bad.map((p) => p.url))}`) : pass(`all ${pages.length} page(s)`);
  };
  per('title_ok', (p) => p.title && p.title.length >= 10 && p.title.length <= 70, 'missing or wrong length');
  per('description_ok', (p) => p.description && p.description.length >= 50 && p.description.length <= 160, 'missing or wrong length');
  per('h1_ok', (p) => p.h1Count === 1, 'not exactly one <h1>');
  per('viewport_ok', (p) => Boolean(p.viewport), 'no viewport meta');
  per('lang_ok', (p) => Boolean(p.lang), 'no lang attribute');

  const probe = await fetchPage(`${origin}/beakon-probe-${crypto.randomBytes(6).toString('hex')}`, { body: false });
  checks.not_found_ok = probe.status === 404 || probe.status === 410 ? pass(`unknown path returns ${probe.status}`) : fail(probe.error || `unknown path returns ${probe.status}`);

  const ogMissing = ['title', 'description', 'image'].filter((k) => !homeDoc.og[k]);
  checks.og_ok = ogMissing.length ? fail(`homepage missing og:${ogMissing.join(', og:')}`) : pass('og:title, og:description, og:image on homepage');

  // ---- Rung 5: structured data and NAP
  const biz = businessNodes(pages);
  const good = biz.find((b) => b.node.name && b.node.url);
  if (good) {
    const n = good.node;
    const extras = [n.telephone ? 'telephone' : null, n.address ? 'address' : null].filter(Boolean);
    checks.schema_business = pass(`${good.types.join('/')} "${n.name}"${extras.length ? ' with ' + extras.join(' + ') : ' (no telephone/address)'}`);
  } else {
    checks.schema_business = fail(biz.length ? `${biz[0].types.join('/')} found but missing name or url` : `no Organization/LocalBusiness JSON-LD (types seen: ${[...new Set(pages.flatMap((p) => jsonldNodes(p.jsonld).flatMap((x) => [].concat(x['@type']))))].join(', ') || 'none'})`);
  }
  const ldTel = biz.some((b) => b.node.telephone);
  const ldAddr = biz.some((b) => b.node.address);
  const tel = homeDoc.hasTelLink || ldTel || PHONE_RE.test(homeDoc.text);
  const addr = homeDoc.hasAddressTag || ldAddr || STREET_RE.test(homeDoc.text);
  checks.nap_visible = tel || addr ? pass(`${tel ? 'phone' : ''}${tel && addr ? ' + ' : ''}${addr ? 'address' : ''} found on homepage`) : fail('no phone (tel: link or number) and no street address on the homepage');

  // ---- Rung 7: analytics
  const analyticsSrc = [...homeDoc.scripts, homeDoc.inlineScript].join('\n');
  const analytics = [
    [/googletagmanager\.com\/gtag\/js|gtag\(/i, 'GA4'], [/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i, 'Google Tag Manager'],
    [/plausible\.io\/js/i, 'Plausible'], [/usefathom\.com|cdn\.fathom/i, 'Fathom'], [/matomo|_paq\.push/i, 'Matomo'],
    [/clarity\.ms/i, 'Microsoft Clarity'], [/umami/i, 'Umami'], [/static\.cloudflareinsights\.com/i, 'Cloudflare Web Analytics'],
  ].filter(([re]) => re.test(analyticsSrc)).map(([, n]) => n);
  checks.analytics_tag = analytics.length ? pass(analytics.join(', ')) : fail('no analytics script on the homepage');

  // ---- Rung 8: depth
  checks.sitemap_depth = sameHost.length >= 8 ? pass(`${sameHost.length} URL(s)`) : fail(`${sameHost.length} URL(s) in the sitemap`);
  const norm = (u) => u.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  const homeLinks = new Set(homeDoc.anchors.map(norm));
  const targets = sameHost.map(norm).filter((u) => u !== norm(home.finalUrl));
  const linked = targets.filter((u) => homeLinks.has(u));
  if (targets.length <= 1) checks.internal_links = pass('nothing to link to yet');
  else checks.internal_links = linked.length >= Math.min(5, Math.ceil(targets.length / 2)) ? pass(`homepage links to ${linked.length}/${targets.length} sitemap pages`) : fail(`homepage links to only ${linked.length}/${targets.length} sitemap pages`);
  const titles = pages.map((p) => (p.title || '').trim().toLowerCase()).filter(Boolean);
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  checks.unique_titles = dupes.length ? fail(`duplicate: "${dupes[0]}"`) : pass(`${titles.length} distinct title(s)`);

  // ---- Rung 1: the profile
  let place = null;
  if (placeId) {
    checks.gbp_listed = pass(`Place ID ${placeId}`);
  } else if (isPlacesConfigured() && businessName) {
    place = await findPlaceForBusiness(businessName, host);
    checks.gbp_listed = place ? pass(`found "${place.name}" (${place.placeId}) with website ${place.website}`) : fail(`no profile named "${businessName}" links to ${host}`);
  } else {
    checks.gbp_listed = fail(isPlacesConfigured() ? 'no business name to search for' : 'no Place ID on record (set GOOGLE_PLACES_API_KEY to look it up automatically)');
  }

  return {
    domain: inputHost, origin, host, checks, place,
    home: { status: home.status, finalUrl: home.finalUrl, ms: home.ms, title: homeDoc.title, description: homeDoc.description },
    pages: pages.map((p) => ({ url: p.url, title: p.title, description: p.description, h1Count: p.h1Count, canonical: p.canonical[0] || null })),
    sitemap: { url: sitemap.url, count: sitemap.urls.length, offHost: offHost.length, newestLastmod: sitemap.lastmods.sort().pop() || null },
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Persistence: attestations and audits
// ---------------------------------------------------------------------------

const BUSINESS_SCOPE = '*';

/** Attestations for a client + site, as { key: { value, note, set_by, set_at } }. Business-scoped ones apply to every site. */
export function listAttestations(clientId, domain) {
  const rows = db.prepare('SELECT * FROM search_attestations WHERE client_id = ? AND (scope_key = ? OR scope_key = ?)').all(clientId, BUSINESS_SCOPE, domain || '');
  const out = {};
  for (const r of rows) out[r.key] = { value: Boolean(r.value), note: r.note, set_by: r.set_by, set_at: r.set_at };
  return out;
}

/** Save a set of { key: boolean|string } for a client + site. Unknown keys are ignored. */
export function setAttestations(clientId, domain, values, setBy = null) {
  const up = db.prepare(`
    INSERT INTO search_attestations (client_id, scope_key, key, value, note, set_by, set_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(client_id, scope_key, key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at
  `);
  const t = now();
  for (const [key, v] of Object.entries(values || {})) {
    const def = ATTESTATIONS[key];
    if (!def) continue;
    const scope = def.scope === 'business' ? BUSINESS_SCOPE : (domain || '');
    const on = v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
    up.run(clientId, scope, key, on ? 1 : 0, setBy, t);
  }
}

/** The distinct site roots Beakon knows for a client: its domain plus every http monitor at a site root. */
export function sitesForClient(client) {
  const hosts = [];
  const add = (u) => {
    try {
      const url = new URL(normalizeUrl(u));
      if (url.pathname !== '/' || url.search) return; // a card page or deep link is not a site
      const h = url.hostname.toLowerCase();
      if (!hosts.includes(h)) hosts.push(h);
    } catch { /* not a URL */ }
  };
  if (client.domain) add(client.domain);
  for (const m of listMonitorsForClient(client.id)) if ((m.type === 'http' || m.type === 'keyword') && m.active) add(m.url);
  return hosts.slice(0, MAX_SITES_PER_CLIENT);
}

function saveAudit(clientId, domain, isPrimary, result, graded) {
  db.prepare(`INSERT INTO search_audits (client_id, domain, is_primary, grade, next_rung, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, domain, isPrimary ? 1 : 0, graded.grade, graded.next?.rung ?? null, JSON.stringify({ result, graded }), now());
}

/** Latest stored audit per domain for a client, primary first. */
export function latestAudits(clientId) {
  const rows = db.prepare(`
    SELECT a.* FROM search_audits a
    WHERE a.client_id = ? AND a.id = (SELECT MAX(id) FROM search_audits b WHERE b.client_id = a.client_id AND b.domain = a.domain)
    ORDER BY a.is_primary DESC, a.domain
  `).all(clientId);
  return rows.map(rowToAudit);
}

export function latestAuditFor(clientId, domain) {
  const r = db.prepare('SELECT * FROM search_audits WHERE client_id = ? AND domain = ? ORDER BY id DESC LIMIT 1').get(clientId, domain);
  return r ? rowToAudit(r) : null;
}

export function auditHistory(clientId, domain, limit = 12) {
  return db.prepare('SELECT id, grade, next_rung, created_at FROM search_audits WHERE client_id = ? AND domain = ? ORDER BY id DESC LIMIT ?').all(clientId, domain, limit);
}

function rowToAudit(r) {
  const data = JSON.parse(r.result_json);
  return { id: r.id, clientId: r.client_id, domain: r.domain, isPrimary: Boolean(r.is_primary), grade: r.grade, nextRung: r.next_rung, createdAt: r.created_at, ...data };
}

/**
 * Re-grade a stored audit against the client's *current* attestations, so
 * ticking a box moves the grade without re-fetching the site.
 */
export function regrade(audit) {
  const att = listAttestations(audit.clientId, audit.domain);
  const flags = Object.fromEntries(Object.entries(att).map(([k, v]) => [k, v.value]));
  return { ...audit, attestations: att, graded: gradeLadder(audit.result.checks, flags) };
}

/**
 * Analyze every site of a client, store each audit, and return the roll-up.
 * opts.placeId — a Place ID the CRM knows (from an NFC card); saved on the client.
 * opts.domains — override the site list (the CRM's client_sites).
 */
export async function analyzeClient(client, { placeId = null, domains = null, setBy = null } = {}) {
  if (placeId && placeId !== client.place_id) {
    db.prepare('UPDATE clients SET place_id = ? WHERE id = ?').run(String(placeId).slice(0, 200), client.id);
    client = getClient(client.id);
  }
  const hosts = (Array.isArray(domains) && domains.length ? domains.map((d) => { try { return new URL(normalizeUrl(d)).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean) : sitesForClient(client)).slice(0, MAX_SITES_PER_CLIENT);
  if (!hosts.length) throw new Error('no site to analyze — give the client a domain or a monitor first');
  const primaryHost = (() => { try { return client.domain ? new URL(normalizeUrl(client.domain)).hostname.toLowerCase() : hosts[0]; } catch { return hosts[0]; } })();

  const sites = [];
  for (const host of hosts) {
    const result = await analyzeSite(host, { placeId: client.place_id, businessName: client.name });
    if (result.place?.placeId && !client.place_id) {
      db.prepare('UPDATE clients SET place_id = ? WHERE id = ?').run(result.place.placeId, client.id);
      client = getClient(client.id);
    }
    const att = listAttestations(client.id, host);
    const graded = gradeLadder(result.checks, Object.fromEntries(Object.entries(att).map(([k, v]) => [k, v.value])));
    const isPrimary = host === primaryHost || (hosts.indexOf(primaryHost) === -1 && host === hosts[0]);
    saveAudit(client.id, host, isPrimary, result, graded);
    sites.push({ domain: host, isPrimary, grade: graded.grade, next: graded.next, graded, result, attestations: att });
  }
  const primary = sites.find((s) => s.isPrimary) || sites[0];
  return { client, primary, sites, ranAt: now(), setBy };
}

/** Compact summary of the latest audits, for the CRM and the admin list. */
export function searchSummary(clientId) {
  const audits = latestAudits(clientId).map(regrade);
  if (!audits.length) return null;
  const primary = audits.find((a) => a.isPrimary) || audits[0];
  return {
    grade: primary.graded.grade,
    domain: primary.domain,
    next: primary.graded.next,
    analyzedAt: primary.createdAt,
    sites: audits.map((a) => ({ domain: a.domain, isPrimary: a.isPrimary, grade: a.graded.grade, next: a.graded.next ? { rung: a.graded.next.rung, name: a.graded.next.name } : null, analyzedAt: a.createdAt })),
  };
}

/** Everything the CRM needs to render the ladder for one client. */
export function searchReportForCrm(clientId) {
  const audits = latestAudits(clientId).map(regrade);
  return {
    ladder: RUNGS.map((r) => ({ rung: r.rung, id: r.id, name: r.name, summary: r.summary, why: r.why || null, checks: r.checks, attestations: r.attestations })),
    checks: CHECKS,
    attestations: ATTESTATIONS,
    summary: searchSummary(clientId),
    sites: audits.map((a) => ({
      domain: a.domain, isPrimary: a.isPrimary, analyzedAt: a.createdAt, grade: a.graded.grade, next: a.graded.next, rungs: a.graded.rungs, ahead: a.graded.ahead,
      checks: a.result.checks, attestations: a.attestations, home: a.result.home, sitemap: a.result.sitemap, pages: a.result.pages,
    })),
  };
}
