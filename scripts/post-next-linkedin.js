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
 * confirmed again 2026-09-04 by inspecting the profile: nothing had posted
 * since a single manual post. A publisher that cannot tell you it failed is
 * worse than no publisher, so this script is built the opposite way round:
 * it only advances the queue on a response LinkedIn itself confirms.
 *
 * Required repo secret:
 *   LINKEDIN_ACCESS_TOKEN  - member token with the w_member_social scope
 *                            (and openid/profile so /v2/userinfo resolves the
 *                            author URN). Tokens last ~60 days; expiry surfaces
 *                            here as a loud 401, never as a silent no-op.
 *
 * Exit codes:
 *   0  posted, or intentionally held (no token yet / queue empty / before startDate)
 *   1  a real failure - queue is NOT advanced, so the item retries tomorrow
 */

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', '_social-queue', 'manifest.json');
const LINKEDIN_VERSION = '202506';

function log(msg) { console.log(`[linkedin] ${msg}`); }
function fail(msg) { console.error(`[linkedin] FAILED: ${msg}`); process.exit(1); }

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

  if (!fs.existsSync(MANIFEST)) fail(`manifest not found at ${MANIFEST}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  if (manifest.startDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (today < manifest.startDate) {
      log(`Holding until startDate ${manifest.startDate} (today is ${today}).`);
      return;
    }
  }

  const queue = Array.isArray(manifest.queue) ? manifest.queue : [];
  if (queue.length === 0) {
    log('Queue is empty. Nothing to post. Refill _social-queue/manifest.json.');
    return;
  }

  const item = queue[0];
  const commentary = htmlToText(item.content || '');
  if (!commentary) fail(`queue item "${item.label}" produced empty text`);

  // 1. Resolve the author URN. Also doubles as a token health check.
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
  log(`Authenticated as ${me.name || me.sub}.`);

  // Smoke-test mode: prove the token works without spending a queue item.
  if (process.env.DRY_RUN === 'true') {
    log('DRY_RUN - token is valid and the author URN resolved. Nothing posted.');
    log(`Author URN: ${author}`);
    log(`Next in queue: "${item.label}" (${commentary.length} chars)`);
    return;
  }

  // 2. Publish.
  const body = {
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
  };

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();

  // 3. Verify. This is the whole point: a post only counts if LinkedIn
  //    hands back the URN of the thing it created.
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
