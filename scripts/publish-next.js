#!/usr/bin/env node
/**
 * Weekly article publisher - runs in GitHub Actions. Zero dependencies, no API keys.
 *
 * Takes the next article listed in _queue/manifest.json and wires it into the live site:
 *   1. Renders _queue/<file> -> insights/<slug>.html   (fills {{DATE}} and {{MONTH_YEAR}})
 *   2. Inserts the index card into insights.html after <div class="posts">
 *   3. Inserts the sitemap entry before </urlset>
 *   4. Removes the item from the queue and deletes the source file
 *   5. Exports PUBLISHED_SLUG / PUBLISHED_URL for later workflow steps (IndexNow, syndication)
 *
 * The workflow then commits + pushes, and Netlify auto-deploys. If the queue is empty
 * it exits cleanly and changes nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const QUEUE_DIR = path.join(ROOT, '_queue');
const MANIFEST = path.join(QUEUE_DIR, 'manifest.json');

const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

if (!fs.existsSync(MANIFEST)) {
  console.log('No _queue/manifest.json - nothing to publish.');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const queue = Array.isArray(manifest.queue) ? manifest.queue : [];
if (queue.length === 0) {
  console.log('QUEUE EMPTY - refill _queue/manifest.json with more articles.');
  process.exit(0);
}

const item = queue[0];
for (const key of ['file', 'slug', 'title', 'description', 'tag']) {
  if (!item[key]) { console.error(`Queue item missing "${key}".`); process.exit(1); }
}

const srcPath = path.join(QUEUE_DIR, item.file);
if (!fs.existsSync(srcPath)) { console.error('Queued file missing: ' + item.file); process.exit(1); }

// 1. Render the article with the real publish date.
const article = fs.readFileSync(srcPath, 'utf8')
  .replace(/{{DATE}}/g, date)
  .replace(/{{MONTH_YEAR}}/g, monthYear);
fs.mkdirSync(path.join(ROOT, 'insights'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'insights', item.slug + '.html'), article);

// 2. insights.html - insert card after <div class="posts"> (idempotent).
const insightsPath = path.join(ROOT, 'insights.html');
let insights = fs.readFileSync(insightsPath, 'utf8');
const slugRe = item.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Match the card in EITHER historical format: single/double quotes, with or without .html.
if (new RegExp(`href=["']/insights/${slugRe}(\\.html)?["']`).test(insights)) {
  console.log('Card already present; skipping insights.html.');
} else {
  // Emit the canonical .html href in the same shape publish.py uses, so the two publishers agree.
  const card = `    <a class='post' href='/insights/${item.slug}.html'><div class="body"><span class="tag">${item.tag}</span><h3>${item.title}</h3><p>${item.description}</p></div></a>`;
  insights = insights.replace(/(<div class="posts">)/, `$1\n${card}`);
  fs.writeFileSync(insightsPath, insights);
}

// 3. sitemap.xml - insert before </urlset> (idempotent).
const sitemapPath = path.join(ROOT, 'sitemap.xml');
let sitemap = fs.readFileSync(sitemapPath, 'utf8');
if (!sitemap.includes(`/insights/${item.slug}.html`)) {
  const loc = `<url><loc>https://howarddavner.com/insights/${item.slug}.html</loc><lastmod>${date}</lastmod><priority>0.7</priority></url>`;
  sitemap = sitemap.replace(/(<\/urlset>)/, `${loc}\n$1`);
  fs.writeFileSync(sitemapPath, sitemap);
}

// 4. Drop the item from the queue and delete its source file.
fs.unlinkSync(srcPath);
manifest.queue = queue.slice(1);
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

// 5. Hand the published slug/URL to the following workflow steps.
const publishedUrl = `https://howarddavner.com/insights/${item.slug}.html`;
if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `PUBLISHED_SLUG=${item.slug}\nPUBLISHED_URL=${publishedUrl}\n`);
}

console.log(`Published "${item.title}" (${item.slug}) on ${date}. ${manifest.queue.length} article(s) left in queue.`);
