#!/usr/bin/env node
/**
 * Non-posting smoke test for the Postiz public API.
 * Confirms POSTIZ_API_KEY authenticates and prints the connected channels
 * so the integration id in _social-queue/manifest.json can be verified.
 */
const API = process.env.POSTIZ_API_BASE || 'https://api.postiz.com/public/v1';
const KEY = process.env.POSTIZ_API_KEY;

if (!KEY) {
  console.error('FAIL: POSTIZ_API_KEY secret is not set on this repository.');
  process.exit(1);
}

(async () => {
  let res, text;
  try {
    res = await fetch(`${API}/integrations`, { headers: { Authorization: KEY } });
    text = await res.text();
  } catch (err) {
    console.error('FAIL: could not reach Postiz - ' + err.message);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`FAIL: Postiz returned ${res.status}.`);
    console.error(String(text).slice(0, 500));
    process.exit(1);
  }

  console.log('OK: API key authenticated.');
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.integrations || data.output || []);
    for (const ch of list) {
      console.log(`  ${ch.id}  ${ch.platform || '?'}  ${ch.name || ''}`);
    }
    console.log(`${list.length} channel(s) connected.`);
  } catch (e) {
    console.log('Raw response: ' + String(text).slice(0, 500));
  }
})();
