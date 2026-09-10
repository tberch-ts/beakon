// src/searchLadder.js
// The Search Ladder: how a client's search position is graded 0–10.
//
// This is a table, not an algorithm. A rung is a set of automated CHECKS
// (Beakon fetched the site and looked) plus ATTESTATIONS (a human logged into
// Google and looked). A client stands on rung N when rungs 1..N are all fully
// cleared; the next phase of work is rung N+1's failing items. Nothing is
// weighted and nothing is averaged, on purpose — see SEARCH-LADDER.md for why.
//
// Edit this file when the evidence from talkstudio.space (or a client) says a
// rung is in the wrong order or a check does not matter. The analyzer
// (search.js) only knows how to run checks by id; the shape of the ladder
// lives here.

export const RUNGS = [
  {
    rung: 0, id: 'invisible', name: 'Invisible',
    summary: 'No working site, or Google is told to stay out.',
    checks: [], attestations: [],
  },
  {
    rung: 1, id: 'on_the_map', name: 'On the map',
    summary: 'A Google Business Profile exists for this business and points at this site.',
    why: 'For a local business the profile is what Google shows first. Everything on the site is decoration until it exists.',
    checks: ['gbp_listed'], attestations: ['gbp_verified'],
  },
  {
    rung: 2, id: 'google_knows', name: 'Google knows the site',
    summary: 'Search Console owns the domain and the site answers at one address.',
    why: 'Search Console is where Google tells you what it sees. Four hostnames for one site split whatever credit you earn four ways.',
    checks: ['https_ok', 'single_host', 'indexable'], attestations: ['gsc_verified'],
  },
  {
    rung: 3, id: 'crawlable', name: 'Crawlable',
    summary: 'Google can find every page without guessing.',
    why: 'A sitemap Google has been handed is the difference between "indexed in days" and "indexed when it gets around to it".',
    checks: ['robots_txt', 'sitemap_found', 'sitemap_in_robots', 'sitemap_urls_ok', 'canonical_present'],
    attestations: ['sitemap_submitted'],
  },
  {
    rung: 4, id: 'says_what_it_is', name: 'Says what it is',
    summary: 'Every page tells Google, and a person, what it is about.',
    why: 'Titles and descriptions are the ad copy Google writes for you. Left blank, Google guesses, and it guesses badly.',
    checks: ['title_ok', 'description_ok', 'h1_ok', 'viewport_ok', 'lang_ok', 'not_found_ok', 'og_ok'],
    attestations: [],
  },
  {
    rung: 5, id: 'structured', name: 'Structured',
    summary: 'The business is described in machine-readable form and it matches the profile.',
    why: 'Name, address and phone that agree everywhere is the cheapest trust signal there is; disagreement is the cheapest way to lose the local pack.',
    checks: ['schema_business', 'nap_visible'], attestations: ['nap_matches_gbp'],
  },
  {
    rung: 6, id: 'local_proof', name: 'Local proof',
    summary: 'The profile is complete and alive, and reviews are arriving.',
    why: 'Reviews and recent posts are what a profile is ranked on once it exists. The NFC cards feed this rung directly.',
    checks: [], attestations: ['gbp_complete', 'gbp_reviews', 'gbp_replies', 'gbp_posting'],
  },
  {
    rung: 7, id: 'indexed_measured', name: 'Indexed and measured',
    summary: 'What was built is actually in the index and someone can see it.',
    why: 'A page that is built but not indexed does not exist. A page that is indexed but unmeasured cannot be improved.',
    checks: ['analytics_tag'], attestations: ['gsc_indexed', 'analytics_live', 'bing_verified'],
  },
  {
    rung: 8, id: 'depth', name: 'Depth',
    summary: 'A page for each thing the business does and each place it does it.',
    why: 'Google ranks pages, not sites. One page that mentions six services ranks for none of them.',
    checks: ['sitemap_depth', 'internal_links', 'unique_titles'], attestations: ['content_pages', 'content_fresh'],
  },
  {
    rung: 9, id: 'authority', name: 'Authority',
    summary: 'The rest of the web agrees the business is real.',
    why: 'Consistent listings and a handful of real links are what separate two otherwise identical local sites.',
    checks: [], attestations: ['directories', 'backlinks', 'local_link'],
  },
  {
    rung: 10, id: 'winning', name: 'Winning',
    summary: 'Search is sending customers and someone is watching.',
    why: 'The ladder is done when the numbers move and a human looks at them every month.',
    checks: [], attestations: ['local_pack', 'clicks_growing', 'conversions_tracked', 'monthly_review'],
  },
];

// Automated checks. `label` is what the admin sees; `fix` is the one-line work
// order when it fails. The analyzer fills in `ok` and `detail`.
export const CHECKS = {
  gbp_listed: { label: 'Business Profile located', fix: 'Record the Place ID (from the CRM card, or search the business name in Google Maps and copy it) so Beakon can tie the profile to this site.' },
  https_ok: { label: 'Homepage answers over HTTPS', fix: 'Get the homepage returning 200 over https:// — this is the same thing the uptime monitor watches.' },
  single_host: { label: 'One host (www/apex/http all redirect to it)', fix: 'Redirect http:// → https:// and the www/non-www variant → the canonical one, with a 301.' },
  indexable: { label: 'Homepage is not noindex', fix: 'Remove the noindex robots meta tag or X-Robots-Tag header from the homepage.' },
  robots_txt: { label: 'robots.txt allows Googlebot', fix: 'Serve a robots.txt that does not Disallow: / for * or Googlebot.' },
  sitemap_found: { label: 'sitemap.xml exists and parses', fix: 'Publish a sitemap.xml listing every indexable page (most site builders generate one).' },
  sitemap_in_robots: { label: 'robots.txt lists the sitemap', fix: 'Add a "Sitemap: https://…/sitemap.xml" line to robots.txt.' },
  sitemap_urls_ok: { label: 'Sitemap URLs return 200 on this host', fix: 'Remove or fix every sitemap entry that redirects, 404s, or points at another host.' },
  canonical_present: { label: 'Pages carry a canonical link', fix: 'Add <link rel="canonical"> to every page pointing at its own https URL.' },
  title_ok: { label: 'Titles present, 10–70 chars', fix: 'Give every page a unique <title> between 10 and 70 characters.' },
  description_ok: { label: 'Meta descriptions present, 50–160 chars', fix: 'Give every page a meta description between 50 and 160 characters.' },
  h1_ok: { label: 'Exactly one H1 per page', fix: 'Each page needs one <h1> that says what the page is.' },
  viewport_ok: { label: 'Mobile viewport meta', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' },
  lang_ok: { label: '<html lang> set', fix: 'Set lang="en" (or the right language) on the <html> element.' },
  not_found_ok: { label: 'Missing pages return a real 404', fix: 'Make unknown paths return HTTP 404, not a 200 with "not found" text.' },
  og_ok: { label: 'Open Graph title, description and image', fix: 'Add og:title, og:description and an og:image (1200×630) so shares and previews carry the brand.' },
  schema_business: { label: 'Organization / LocalBusiness JSON-LD with name + url', fix: 'Add a JSON-LD block of type Organization (or a LocalBusiness subtype) with name, url and, for a local business, address and telephone.' },
  nap_visible: { label: 'Phone or address visible on the site', fix: 'Put the business phone (as a tel: link) and address on the homepage and contact page, exactly as they appear on the profile.' },
  analytics_tag: { label: 'Analytics tag on the homepage', fix: 'Install GA4 (or Plausible/Fathom/Matomo) on every page.' },
  sitemap_depth: { label: 'At least 8 indexable pages in the sitemap', fix: 'Build out one page per service/product and one per service area; a 3-page site cannot rank for 12 things.' },
  internal_links: { label: 'Homepage links to the sitemap pages', fix: 'Link the service and location pages from the homepage navigation or body.' },
  unique_titles: { label: 'No duplicate titles across pages', fix: 'Rewrite pages that share a title so each targets its own query.' },
};

// Human attestations. `scope` is 'business' (shared across a client's sites —
// the profile, listings, links) or 'site' (per domain — Search Console,
// analytics, content). `how` is where to go look.
export const ATTESTATIONS = {
  gbp_verified: { scope: 'business', label: 'Google Business Profile claimed, verified, website field = this domain', how: 'business.google.com → the profile shows "Verified" and the website matches.' },
  gsc_verified: { scope: 'site', label: 'Search Console Domain property verified', how: 'search.google.com/search-console → add a Domain property (covers www, apex, http, https) and verify via DNS TXT.' },
  sitemap_submitted: { scope: 'site', label: 'Sitemap submitted in Search Console, status Success', how: 'Search Console → Sitemaps → submit sitemap.xml, wait for "Success".' },
  nap_matches_gbp: { scope: 'business', label: 'Name, address, phone on the site match the profile exactly', how: 'Compare the footer/contact page with the profile character for character (suite numbers, "St" vs "Street").' },
  gbp_complete: { scope: 'business', label: 'Profile complete: categories, hours, description, services, 10+ photos', how: 'Profile → Edit profile; every section filled, primary + secondary categories set.' },
  gbp_reviews: { scope: 'business', label: '10+ reviews, 4.0+ average', how: 'Profile → Reviews. The NFC review cards are the engine for this.' },
  gbp_replies: { scope: 'business', label: 'Owner replies to reviews (all of the last 10)', how: 'Profile → Reviews → each has a reply.' },
  gbp_posting: { scope: 'business', label: 'A profile post in the last 30 days', how: 'Profile → Add update. One a month is the floor.' },
  gsc_indexed: { scope: 'site', label: 'Indexed pages ≥ 80% of sitemap URLs, no indexing errors', how: 'Search Console → Pages: compare "Indexed" with the sitemap count; "Why pages aren\'t indexed" is empty of errors.' },
  analytics_live: { scope: 'site', label: 'Analytics receiving traffic (GA4 or equivalent)', how: 'GA4 → Reports → Realtime shows hits when you load the site.' },
  bing_verified: { scope: 'site', label: 'Bing Webmaster Tools verified', how: 'bing.com/webmasters → Import from Search Console (one click, free traffic).' },
  content_pages: { scope: 'site', label: 'One page per core service/product, one per service area, an about/FAQ', how: 'Walk the sitemap against the list of what they sell and where.' },
  content_fresh: { scope: 'site', label: 'Something updated in the last 90 days', how: 'Sitemap lastmod, or the newest post/page date.' },
  directories: { scope: 'business', label: 'NAP-consistent listings: Apple Maps, Bing Places, Yelp, Facebook, industry directory', how: 'Search the business name on each; fix anything that disagrees with the profile.' },
  backlinks: { scope: 'business', label: '5+ referring domains', how: 'Search Console → Links → Top linking sites (or Bing Webmaster → Backlinks).' },
  local_link: { scope: 'business', label: 'At least one local press / partner / sponsor link', how: 'A chamber of commerce, a sponsored team, a local news mention, a supplier\'s "our customers" page.' },
  local_pack: { scope: 'business', label: 'Top 3 for "service + city", and in the local pack', how: 'Search it in an incognito window from the service area (or Search Console → Performance filtered to the query).' },
  clicks_growing: { scope: 'site', label: 'Search Console clicks up quarter over quarter', how: 'Search Console → Performance → compare last 3 months with previous.' },
  conversions_tracked: { scope: 'site', label: 'Calls, form fills or bookings tracked as conversions', how: 'GA4 → Admin → Events marked as key events; profile call clicks in GBP Insights.' },
  monthly_review: { scope: 'business', label: 'Monthly review of Search Console + profile insights on the calendar', how: 'A recurring CRM task. The ladder is only done if someone keeps looking.' },
};

export const MAX_RUNG = RUNGS[RUNGS.length - 1].rung;

export function rungOf(n) {
  return RUNGS.find((r) => r.rung === n) || null;
}

/**
 * Grade a site from its check results and the client's attestations.
 * checks: { [id]: { ok: boolean, detail?: string } }
 * attestations: { [id]: truthy }
 * Returns { grade, next, rungs: [{ rung, name, cleared, failing: [checkId], missing: [attestId] }], ahead }.
 * `ahead` lists items already passing on rungs above the next one — real, but
 * not credit until the rungs beneath them clear.
 */
export function grade(checks = {}, attestations = {}) {
  const rungs = RUNGS.filter((r) => r.rung > 0).map((r) => {
    const failing = r.checks.filter((id) => !checks[id]?.ok);
    const missing = r.attestations.filter((id) => !attestations[id]);
    return { rung: r.rung, id: r.id, name: r.name, summary: r.summary, why: r.why, cleared: failing.length === 0 && missing.length === 0, failing, missing };
  });
  let g = 0;
  for (const r of rungs) {
    if (!r.cleared) break;
    g = r.rung;
  }
  const next = g >= MAX_RUNG ? null : rungs.find((r) => r.rung === g + 1);
  const ahead = [];
  for (const r of rungs) {
    if (next && r.rung <= next.rung) continue;
    const def = rungOf(r.rung);
    for (const id of def.checks) if (checks[id]?.ok) ahead.push({ rung: r.rung, kind: 'check', id, label: CHECKS[id].label });
    for (const id of def.attestations) if (attestations[id]) ahead.push({ rung: r.rung, kind: 'attestation', id, label: ATTESTATIONS[id].label });
  }
  return { grade: g, next: next ? { rung: next.rung, id: next.id, name: next.name, summary: next.summary, why: next.why, failing: next.failing, missing: next.missing } : null, rungs, ahead };
}
