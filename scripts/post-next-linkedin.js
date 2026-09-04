#!/usr/bin/env node
/**
 * post-next-linkedin.js
 *
 * Publishes the next queued item straight to LinkedIn's own REST API.
 * Deliberately does NOT go through Postiz.
 *
 * Background: Postiz marked posts PUBLISHED that never reached LinkedIn
 * (their open issue #989, plus a deprecated LinkedIn API version in #1187
 * closed as not-planned). Verified twice on this account in August 2026 and
 * confirmed again 2026-09-04 by inspecting the profile: exactly one post
 * existed, posted by hand. A publisher that cannot tell you it failed is
 * worse than no publisher, so this script is built the opposite way round:
 * it only advances the queue on a response LinkedIn itself confirms.
 *
 * Two failure modes are handled structurally rather than by hope:
 *   1. Silent success - impossible here. A post counts only when LinkedIn
 *      returns the x-restli-id URN of the row it created.
 *   2. Version rot - LinkedIn retires dated API versions continuously, and a
 *      pinned version eventually returns 426 NONEXISTENT_VERSION forever.
 *      That is what killed Postiz. So the version is negotiated from the
 *      current date at run time, not hardcoded.
 *
 * Required repo secret:
 *   LINKEDIN_ACCESS_TOKEN  - member token with the w_member_social scope
 *                            (and openid/profile so /v2/userinfo resolves the
 *                            author URN). Tokens last ~60 days; expiry surfaces
 *                            here as a loud 401, never as a silent no-op.
 *
 * Optional env:
 *   DRY_RUN=true          - verify the token, publish nothing
 *   LINKEDIN_VERSION      - pin one version (e.g. 202608) instead of negotiating
 *
 * Exit codes:
 *   0  posted, or intentionally held (no token yet / queue empty / dry run)
 *   1  a real failure - queue is NOT advanced, so the item retries tomorrow
 */

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', '_social-queue', 'manifest.json');
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const VERSION_LOOKBACK_MONTHS = 18;

function log(msg) { console.log(`[linkedin] ${msg}`); }
function fail(msg) { console.error(`[linkedin] FAILED: ${msg}`); process.exit(1); }

/**
 * LinkedIn versions are YYYYMM strings, minted monthly and retired after about
 * a year. Deriving them from today's date means this list is always current -
 * the script cannot rot the way a pinned constant does.
 */
function candidateVersions() {
  if (process.env.LINKEDIN_VERSION) return [process.env.LINKEDIN_VERSION];
  const out = [];
  const now = new Date();
  for (let i = 0; i < VERSION_LOOKBACK_MONTHS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Queue items are stored as simple HTML. LinkedIn commentary is plain text. */
function htmlToText(html) {
  return html
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function main() {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    log('LINKEDIN_ACCESS_TOKEN is not set. Holding - nothing posted, queue untouched.');
    log('Add the secret in Settings > Secrets and variables > Actions to go live.');
    return;
  }

  // 1. Resolve the author URN. Doubles as a token health check, so it runs
  //    before any queue logic - a smoke test should test the credential even
  //    when the queue is empty.
  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (meRes.status === 401) {
    fail('401 from LinkedIn - the access token is expired or revoked. Generate a new one and update the LINKEDIN_ACCESS_TOKEN secret.');
  }
  if (!meRes.ok) {
    fail(`/v2/userinfo returned ${meRes.status}: ${await meRes.text()}`);
  }
  const me = await meRes.json();
  if (!me.sub) fail('/v2/userinfo returned no "sub" - cannot build the author URN.');
  const author = `urn:li:person:${me.sub}`;
  log(`Token OK. Authenticated as ${me.name || me.sub}.`);

  if (!fs.existsSync(MANIFEST)) fail(`manifest not found at ${MANIFEST}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  const queue = Array.isArray(manifest.queue) ? manifest.queue : [];
  if (queue.length === 0) {
    log('Queue is empty. Nothing to post. Refill _social-queue/manifest.json.');
    return;
  }

  const item = queue[0];
  const commentary = htmlToText(item.content || '');
  if (!commentary) fail(`queue item "${item.label}" produced empty text`);

  if (process.env.DRY_RUN === 'true') {
    log('DRY_RUN - credentials verified, nothing posted, queue untouched.');
    log(`Author URN: ${author}`);
    log(`Next in queue: "${item.label}" (${commentary.length} chars)`);
    log(`Queue depth: ${queue.length}`);
    return;
  }

  // 2. Publish, negotiating the API version.
  const body = JSON.stringify({
    author,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  });

  const versions = candidateVersions();
  let res = null;
  let raw = '';
  let usedVersion = null;
  const retired = [];

  for (const version of versions) {
    res = await fetch(POSTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': version,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body,
    });
    raw = await res.text();

    // 426 NONEXISTENT_VERSION means only that this dated version is retired.
    // Any other response is a real answer about the post itself - stop here.
    if (res.status === 426 && raw.includes('NONEXISTENT_VERSION')) {
      retired.push(version);
      continue;
    }
    usedVersion = version;
    break;
  }

  if (retired.length) log(`Retired API versions skipped: ${retired.join(', ')}`);

  if (!usedVersion) {
    fail(`every candidate LinkedIn API version was rejected as retired (tried ${versions.length}, oldest ${versions[versions.length - 1]}). Check LinkedIn's current version list and set LINKEDIN_VERSION.`);
  }
  log(`Using LinkedIn API version ${usedVersion}.`);

  // 3. Verify. A post only counts if LinkedIn hands back the URN of the
  //    thing it created.
  if (!res.ok) {
    fail(`LinkedIn returned ${res.status} for "${item.label}": ${raw}`);
  }
  const postUrn = res.headers.get('x-restli-id');
  if (!postUrn) {
    fail(`LinkedIn returned ${res.status} but no x-restli-id header for "${item.label}". Treating as NOT published. Body: ${raw}`);
  }

  log(`Published "${item.label}" as ${postUrn}`);
  log(`https://www.linkedin.com/feed/update/${postUrn}/`);

  // 4. Only now advance the queue.
  manifest.queue = queue.slice(1);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  log(`Queue advanced. ${manifest.queue.length} item(s) remaining.`);
  if (manifest.queue.length <= 3) {
    log('WARNING: queue is running low. Refill _social-queue/manifest.json.');
  }
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
