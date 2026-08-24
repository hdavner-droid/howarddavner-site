#!/usr/bin/env node
/**
 * Daily social poster - runs in GitHub Actions. Zero dependencies (Node 20 global fetch).
 *
 * Takes the next item in _social-queue/manifest.json, publishes it through the
 * Postiz public API (type: now), then drops it from the queue. The workflow
 * commits the shortened queue, so each item posts exactly once.
 *
 * Holds until manifest.startDate so it never collides with posts that were
 * already scheduled inside Postiz itself.
 */
const fs = require('fs');
const path = require('path');

const API = process.env.POSTIZ_API_BASE || 'https://api.postiz.com/public/v1';
const KEY = process.env.POSTIZ_API_KEY;
const MANIFEST = path.join(process.cwd(), '_social-queue', 'manifest.json');

if (!fs.existsSync(MANIFEST)) {
  console.log('No _social-queue/manifest.json - nothing to post.');
  process.exit(0);
}
if (!KEY) {
  console.error('POSTIZ_API_KEY is not set. Add it as a repository secret.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

if (manifest.startDate && today < manifest.startDate) {
  console.log(`Holding until ${manifest.startDate} (posts already scheduled inside Postiz until then). Today is ${today}.`);
  process.exit(0);
}

const queue = Array.isArray(manifest.queue) ? manifest.queue : [];
if (queue.length === 0) {
  console.log('SOCIAL QUEUE EMPTY - refill _social-queue/manifest.json.');
  process.exit(0);
}

const item = queue[0];
const integrationId = item.integrationId || manifest.integrationId;
const platform = item.platform || manifest.platform || 'linkedin';

if (!integrationId || !item.content) {
  console.error('Queue item is missing integrationId or content.');
  process.exit(1);
}

const body = {
  type: 'now',
  date: new Date().toISOString(),
  shortLink: false,
  tags: [],
  posts: [{
    integration: { id: integrationId },
    value: [{ content: item.content, image: [] }],
    settings: { __type: platform }
  }]
};

(async () => {
  let res, text;
  try {
    res = await fetch(`${API}/posts`, {
      method: 'POST',
      headers: { Authorization: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    text = await res.text();
  } catch (err) {
    console.error('Network error calling Postiz: ' + err.message);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`Postiz returned ${res.status}: ${text}`);
    console.error('Queue NOT advanced - this item will be retried on the next run.');
    process.exit(1);
  }

  console.log(`Posted "${item.label || '(unlabeled)'}" to ${platform}.`);
  console.log('Postiz response: ' + String(text).slice(0, 300));

  manifest.queue = queue.slice(1);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${manifest.queue.length} post(s) left in the social queue.`);
})();
