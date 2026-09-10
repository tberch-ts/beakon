# The Search Ladder — grading a client's search position from 0 to 10

Beakon watches whether a client's site is *up*. The Search Ladder watches
whether anyone can *find* it. Every client gets a grade from 0 to 10, and the
grade is not a score that is added up — it is a **ladder**: you stand on the
highest rung whose every requirement you meet, *and every rung below it*. The
next phase of search work for a client is always, exactly, the first rung they
have not cleared. That is what the **Analyze search** button in the CRM tells
you.

We are climbing it ourselves first on **talkstudio.space**. Whatever moves us
up a rung becomes the playbook for moving a client up the same rung; whatever
turns out not to matter gets removed from the rung. The ladder is a living
table (`src/searchLadder.js`), not a standard — change it when the evidence
says to.

## Why a ladder and not a percentage

A percentage hides the order of operations. A site can have perfect schema
markup and no Google Business Profile, and a percentage would call that 60%.
It is not 60%. For a local business, a GBP is the thing Google shows first, and
without it the schema is decoration. The ladder forces the cheap, high-leverage
foundations first and refuses to give credit for polish on top of a missing
floor. It also turns "what should we do next?" into a lookup rather than a
judgement call.

## The rungs

Each rung has **automated checks** (Beakon fetches the site and reads what is
there) and **attestations** (things only a human logged into Google can
confirm — recorded once per client in the admin console, with a date). A rung
is cleared when all of its checks pass and all of its attestations are marked.

| Rung | Name | What it means | How it is confirmed |
|---|---|---|---|
| **0** | Invisible | There is no working site, or Google is told to stay out. | Domain does not resolve, HTTPS fails, homepage is not 200, or `robots.txt` / `<meta name=robots>` blocks Googlebot from everything. |
| **1** | On the map | A Google Business Profile exists for this business and points at this site. | Attest: GBP claimed, verified, website field = this domain. Auto: Place ID known (CRM already stores it for NFC-card customers). |
| **2** | Google knows the site | Search Console owns the domain; the site is one address, not four. | Attest: Search Console **Domain property** verified. Auto: `www` and apex redirect to one canonical host, HTTP→HTTPS, homepage not `noindex`. |
| **3** | Crawlable | Google can find every page without guessing. | Auto: valid `robots.txt` that allows Googlebot; `sitemap.xml` parses, is listed in `robots.txt`, every URL in it returns 200 and lives on the same host; `<link rel=canonical>` on sampled pages. Attest: sitemap submitted in Search Console. |
| **4** | Says what it is | Every page tells Google, and a person, what it is about. | Auto (homepage + sampled sitemap pages): unique `<title>` (10–70 chars), `meta description` (50–160 chars), exactly one `<h1>`, viewport meta, `lang` attribute, a working 404 that actually returns 404, `og:title`/`og:description`/`og:image`. |
| **5** | Structured | The business is described in machine-readable form, and it matches the GBP. | Auto: JSON-LD with `Organization` or `LocalBusiness` (a subtype counts) carrying `name`, `url`, and for a local business `address` + `telephone`; the visible page shows the same name/address/phone (NAP). Attest: NAP on the site matches the GBP exactly. |
| **6** | Local proof | The profile is complete and alive; reviews are arriving. | Attest: GBP has primary + secondary categories, hours, ≥10 photos, services/products, a description; ≥10 reviews with ≥4.0 average; owner replies to reviews; at least one GBP post in the last 30 days. (NFC review cards feed this rung directly.) |
| **7** | Indexed and measured | What we built is actually in the index, and we can see it. | Attest: Search Console shows indexed pages ≥ 80% of sitemap URLs with no Page-indexing errors; GA4 (or equivalent) receiving traffic; Bing Webmaster Tools verified (free import from Search Console). Auto: an analytics tag is present on the homepage. |
| **8** | Depth | There is a page for each thing the business does, and each place it does it. | Auto: sitemap has ≥ 8 indexable URLs; internal links from the homepage reach the service/location pages; no duplicate titles across sampled pages. Attest: one page per core service/product, one per service area, an FAQ or about page, content updated in the last 90 days. |
| **9** | Authority | The rest of the web agrees the business is real. | Attest: NAP-consistent listings on the major directories (Apple Maps, Bing Places, Yelp, Facebook, the relevant industry directory); ≥ 5 referring domains; at least one local press/partner/sponsor link. |
| **10** | Winning | Search is sending customers, and someone is watching. | Attest: top-3 for the primary "service + city" query and in the local pack for it; Search Console clicks up quarter over quarter; conversions (calls, form fills, bookings) tracked; a monthly review of Search Console + GBP Insights is on the calendar. |

## Reading a result

Analyze search returns three things for a client:

1. **Grade** — the rung they stand on (0–10).
2. **Next phase** — the first rung not cleared, with the specific failing checks
   and unmarked attestations listed. That is the work order.
3. **Everything else that is already good higher up** — checks passing on rungs
   above the grade. Those are not credit, but they are real and they mean the
   next phase will be cheaper than it looks.

The grade only moves when a rung is fully cleared. A client at 3 who fixes half
of rung 4 is still a 3; the next-phase list just gets shorter.

## Clients with more than one site

A client is one business; a business may run several sites (we do: the live
platform, the CRM, marketing, the marketplace). The rules are:

- **One host, many products → one sitemap, one Search Console property, one
  grade.** A sitemap may only list URLs on the host it is served from, so if
  the products live at `/predict/`, `/products/`, `/market/` on one domain, a
  single `sitemap.xml` covers all of them and the whole domain is one thing to
  Google. This is the easy case and it is where talkstudio.space is today.
- **Separate domains → separate ladders.** Each domain needs its own sitemap
  and its own Search Console verification (a *Domain property* covers every
  subdomain and protocol of one registrable domain, not other domains). Beakon
  grades each domain on its own; the client's headline grade is the grade of
  the **primary** domain, and the other domains are listed under it with their
  own grade and next phase. Cross-host sitemap submission via `robots.txt` is
  possible but only worth it for a client with a dozen brands.
- **One GBP per physical business, not per website.** Different products under
  one company at one address share the GBP. Only a genuinely separate business
  (its own name, its own storefront or service area) gets a second profile.

## What we learn on talkstudio.space, as of 2026-09-10

The first live run against our own site, recorded here so the ladder stays
honest:

- HTTPS, `www`→apex redirect, `robots.txt`, `sitemap.xml` (16 URLs, all 200),
  canonicals, titles, descriptions, single `h1`, `Organization` + `WebSite`
  JSON-LD, breadcrumbs, a real 404, GA4 tag — all present.
- Missing: `og:image` on every page; no telephone or address anywhere on the
  site, so no NAP and no `LocalBusiness`; venue pages carry `WebPage` but not
  `LocalBusiness`/`BarOrPub` schema for the venue; no Google Business Profile
  attested; no Search Console attestation on record.
- So we sit on **rung 0 → 1 pending GBP**, despite most of rungs 2–4 already
  passing. That is the ladder doing its job: the highest-leverage missing piece
  is the cheapest one, and it is not a code change.
