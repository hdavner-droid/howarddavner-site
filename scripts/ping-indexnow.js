#!/usr/bin/env node
/**
 * Submits the freshly published URL to IndexNow (Bing, Yandex, Seznam, Naver).
 * No API key or account needed - ownership is proven by the key file served at
 * https://howarddavner.com/<KEY>.txt
 *
 * Reads PUBLISHED_URL from the environment (set by scripts/publish-next.js).
 * Never fails the build: indexing is a nice-to-have, not a publish blocker.
 */
const KEY = 'acdb054091e685c9000e066657e84051';
const HOST = 'howarddavner.com';
const url = process.env.PUBLISHED_URL;

if (!url) {
  console.log('No PUBLISHED_URL set - nothing was published this run. Skipping IndexNow.');
  process.exit(0);
}

const body = {
  host: HOST,
  key: KEY,
  keyLocation: `https://${HOST}/${KEY}.txt`,
  urlList: [url, `https://${HOST}/insights.html`, `https://${HOST}/sitemap.xml`]
};

(async () => {
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (res.ok || res.status === 202) {
      console.log(`IndexNow accepted the submission (HTTP ${res.status}) for ${url}`);
    } else {
      console.log(`IndexNow returned HTTP ${res.status}. Not fatal - the sitemap still covers it.`);
      console.log(String(await res.text()).slice(0, 300));
    }
  } catch (err) {
    console.log('IndexNow ping failed (non-fatal): ' + err.message);
  }
})();
