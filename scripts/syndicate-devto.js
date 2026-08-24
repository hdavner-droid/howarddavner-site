#!/usr/bin/env node
/**
 * Syndicates the freshly published article to Dev.to through Postiz.
 *
 * Uses the existing POSTIZ_API_KEY secret and the already-connected Dev.to channel,
 * so no Dev.to login or separate API key is required.
 *
 * The Dev.to copy carries rel=canonical back to howarddavner.com, so Google credits
 * the original and the Dev.to URL becomes a second owned, indexable result.
 *
 * Reads PUBLISHED_SLUG / PUBLISHED_URL from the environment (set by publish-next.js).
 * Never fails the build - syndication is a bonus, not a publish blocker.
 */
const fs = require('fs');
const path = require('path');

const API = process.env.POSTIZ_API_BASE || 'https://api.postiz.com/public/v1';
const KEY = process.env.POSTIZ_API_KEY;
const DEVTO_INTEGRATION = process.env.DEVTO_INTEGRATION_ID || 'cmpet1kuq03uiny0yre03ylsw';

const slug = process.env.PUBLISHED_SLUG;
const url = process.env.PUBLISHED_URL;

if (!slug || !url) {
  console.log('Nothing published this run - skipping Dev.to syndication.');
  process.exit(0);
}
if (!KEY) {
  console.log('POSTIZ_API_KEY not set - skipping Dev.to syndication (non-fatal).');
  process.exit(0);
}

// Dev.to tag ids, mapped from the site's own tag vocabulary. Max 4 per post.
const TAG_MAP = {
  Careers: [{ value: 630, label: 'career' }, { value: 91, label: 'hiring' }],
  Leadership: [{ value: 956, label: 'leadership' }, { value: 110, label: 'management' }],
  Product: [{ value: 1419, label: 'product' }, { value: 280, label: 'startup' }],
  Retail: [{ value: 280, label: 'startup' }, { value: 765, label: 'marketing' }],
  Finance: [{ value: 2972, label: 'fintech' }, { value: 280, label: 'startup' }],
  Entrepreneurship: [{ value: 280, label: 'startup' }, { value: 4762, label: 'indie' }],
  Ventures: [{ value: 280, label: 'startup' }, { value: 4762, label: 'indie' }],
  Industry: [{ value: 280, label: 'startup' }, { value: 765, label: 'marketing' }],
  Pricing: [{ value: 280, label: 'startup' }, { value: 765, label: 'marketing' }]
};
const DEFAULT_TAGS = [{ value: 630, label: 'career' }, { value: 280, label: 'startup' }];

const file = path.join(process.cwd(), 'insights', slug + '.html');
if (!fs.existsSync(file)) {
  console.log('Published file not found at ' + file + ' - skipping syndication.');
  process.exit(0);
}
const html = fs.readFileSync(file, 'utf8');

const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
const title = titleMatch ? titleMatch[1].trim() : slug.replace(/-/g, ' ');

const tagMatch = html.match(/<span class="tag">([^<]+)<\/span>/i);
const siteTag = tagMatch ? tagMatch[1].trim() : '';
const tags = TAG_MAP[siteTag] || DEFAULT_TAGS;

// Pull just the article body (paragraphs and subheads) out of <article>...</article>.
const articleMatch = html.match(/<article>[\s\S]*?<\/article>/i);
const articleHtml = articleMatch ? articleMatch[0] : '';
const blocks = articleHtml.match(/<(p|h2)>[\s\S]*?<\/\1>/gi) || [];

if (blocks.length === 0) {
  console.log('Could not extract article body - skipping syndication (non-fatal).');
  process.exit(0);
}

const body = blocks.join('') +
  `<p><em>This piece first appeared on <a href="${url}">howarddavner.com</a>.</em></p>`;

const payload = {
  type: 'now',
  date: new Date().toISOString(),
  shortLink: false,
  tags: [],
  posts: [{
    integration: { id: DEVTO_INTEGRATION },
    value: [{ content: body, image: [] }],
    settings: { __type: 'devto', title: title, canonical: url, tags: tags }
  }]
};

(async () => {
  try {
    const res = await fetch(`${API}/posts`, {
      method: 'POST',
      headers: { Authorization: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`Dev.to syndication returned HTTP ${res.status} (non-fatal).`);
      console.log(String(text).slice(0, 400));
      process.exit(0);
    }
    console.log(`Syndicated "${title}" to Dev.to with canonical ${url}`);
    console.log('Tags: ' + tags.map(t => t.label).join(', '));
    console.log('Postiz response: ' + String(text).slice(0, 300));
  } catch (err) {
    console.log('Dev.to syndication failed (non-fatal): ' + err.message);
  }
})();
