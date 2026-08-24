#!/usr/bin/env node
/**
 * Keeps the article queue topped up so it never runs dry.
 *
 * Runs after the weekly publish. If _queue/manifest.json has fewer than
 * TARGET_QUEUE articles left, it writes new ones with the Anthropic API and
 * appends them to the queue, matching the exact site template.
 *
 * Requires the ANTHROPIC_API_KEY repository secret.
 * Never fails the build - a missed top-up just means a shorter queue.
 *
 * Cost is a few cents per article.
 */
const fs = require('fs');
const path = require('path');

const KEY = process.env.ANTHROPIC_API_KEY;
const TARGET_QUEUE = parseInt(process.env.TARGET_QUEUE || '4', 10);
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '2', 10);

const ROOT = process.cwd();
const QUEUE_DIR = path.join(ROOT, '_queue');
const MANIFEST = path.join(QUEUE_DIR, 'manifest.json');

if (!KEY) {
  console.log('ANTHROPIC_API_KEY not set - skipping queue top-up (non-fatal).');
  process.exit(0);
}
if (!fs.existsSync(MANIFEST)) {
  console.log('No _queue/manifest.json - skipping top-up.');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
manifest.queue = Array.isArray(manifest.queue) ? manifest.queue : [];

const need = Math.min(TARGET_QUEUE - manifest.queue.length, MAX_PER_RUN);
if (need <= 0) {
  console.log(`Queue has ${manifest.queue.length} article(s) - at or above target of ${TARGET_QUEUE}. Nothing to write.`);
  process.exit(0);
}

// Everything already published or already queued, so we never repeat a topic.
function existingSlugs() {
  const out = new Set();
  const dir = path.join(ROOT, 'insights');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.html')) out.add(f.replace(/\.html$/, ''));
    }
  }
  for (const q of manifest.queue) if (q.slug) out.add(q.slug);
  return [...out];
}

const TAGS = ['Careers', 'Ventures', 'Industry', 'Leadership', 'Finance', 'Product', 'Entrepreneurship', 'Retail', 'Pricing'];

function template({ title, description, slug, tag, role, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="https://howarddavner.com/insights/${slug}.html">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="article:author" content="Howard Davner">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"${title}","author":{"@type":"Person","name":"Howard Davner","url":"https://howarddavner.com/"},"datePublished":"{{DATE}}","dateModified":"{{DATE}}","mainEntityOfPage":"https://howarddavner.com/insights/${slug}.html","description":"${description}","publisher":{"@type":"Person","name":"Howard Davner"}}
</script>
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header class="nav"><div class="navw nav-in">
  <div class="brand">Howard <span>Davner</span></div>
  <nav><ul><li><a href="/#about">About</a></li><li><a href="/#career">Career</a></li><li><a href="/insights">Insights</a></li><li><a href="/#contact">Contact</a></li></ul></nav>
</div></header>
<div class="hero"><div class="wrap">
  <span class="tag">${tag}</span>
  <h1>${title}</h1>
  <div class="byline">By Howard Davner · ${role} · {{MONTH_YEAR}}</div>
</div></div>
<article><div class="wrap">
${bodyHtml}
</div></article>
<footer><div class="wrap">© 2026 Howard Davner · <a href="/">howarddavner.com</a> · <a href="https://www.linkedin.com/in/howarddavner" rel="me">LinkedIn</a></div></footer>
</body>
</html>
`;
}

async function pickModel() {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  // Resolve a current model at run time so this keeps working as models change.
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }
    });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id);
      const sonnet = ids.find(id => /sonnet/i.test(id));
      const opus = ids.find(id => /opus/i.test(id));
      const chosen = sonnet || opus || ids[0];
      if (chosen) { console.log('Using model: ' + chosen); return chosen; }
    }
  } catch (e) {
    console.log('Model listing failed, falling back: ' + e.message);
  }
  return 'claude-sonnet-4-5';
}

function buildPrompt(taken) {
  return `You write essays published under Howard Davner's byline on howarddavner.com.

About Howard: CEO of Beverage USA Holdings, co-founder of NERD Focus (a nootropic functional energy drink), and founder of Provieo, an AI platform that helps people get hired on the strength of demonstrated work. Formerly in finance.

Write ONE new essay.

TOPIC RULES
- Roughly 60% of essays are about careers, hiring, talent, management, or how AI is changing work. Those carry the byline role "Founder, Provieo".
- Roughly 40% are about functional beverage, retail, product, pricing, or entrepreneurship. Those carry the byline role "CEO, Beverage USA Holdings".
- Pick a genuinely fresh angle. These slugs are already used, so do NOT repeat their topics: ${taken.join(', ')}

VOICE
- First person, thoughtful, concrete, specific. Written by an operator who has actually done the thing.
- No hype, no buzzwords, no listicles, no emoji, no exclamation marks.
- Open with a specific observation or moment, not a thesis statement.
- Admit uncertainty or a mistake where it is honest to do so.
- Never invent statistics, studies, dollar figures, or named people.

STRUCTURE
- 6 to 7 substantial paragraphs.
- 2 or 3 <h2> subheads placed between paragraphs (never at the very start or very end).
- Body HTML must use ONLY <p> and <h2> tags. No other tags, no markdown, no attributes.

Return ONLY a JSON object, no prose and no code fences, with exactly these keys:
{
  "title": "Title Case, 3-7 words, no colon",
  "slug": "kebab-case-from-the-title",
  "tag": "one of: ${TAGS.join(' | ')}",
  "role": "Founder, Provieo" or "CEO, Beverage USA Holdings",
  "description": "one or two sentences, under 200 characters, no quotes inside",
  "body_html": "the full essay as <p> and <h2> tags concatenated"
}`;
}

async function writeOne(model, taken) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{ role: 'user', content: buildPrompt(taken) }]
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic API returned ${res.status}: ${String(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const art = JSON.parse(text);
  for (const k of ['title', 'slug', 'tag', 'role', 'description', 'body_html']) {
    if (!art[k]) throw new Error('Model response missing "' + k + '"');
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(art.slug)) throw new Error('Bad slug: ' + art.slug);
  if (taken.includes(art.slug)) throw new Error('Duplicate slug: ' + art.slug);
  if (!TAGS.includes(art.tag)) art.tag = 'Careers';
  if (!/^(Founder, Provieo|CEO, Beverage USA Holdings)$/.test(art.role)) art.role = 'Founder, Provieo';
  if (/<(?!\/?(p|h2)\b)[a-z]/i.test(art.body_html)) throw new Error('Body contains disallowed tags');

  const file = art.slug + '.html';
  fs.writeFileSync(path.join(QUEUE_DIR, file), template({
    title: art.title,
    description: art.description.replace(/"/g, ''),
    slug: art.slug,
    tag: art.tag,
    role: art.role,
    bodyHtml: art.body_html
  }));

  manifest.queue.push({
    file,
    slug: art.slug,
    title: art.title,
    tag: art.tag,
    description: art.description.replace(/"/g, '')
  });

  return art;
}

(async () => {
  const model = await pickModel();
  let written = 0;

  for (let i = 0; i < need; i++) {
    const taken = existingSlugs();
    try {
      const art = await writeOne(model, taken);
      written++;
      console.log(`Wrote "${art.title}" (${art.slug}) [${art.tag}] into the queue.`);
    } catch (err) {
      console.log('Article generation failed (non-fatal): ' + err.message);
      break;
    }
  }

  if (written > 0) {
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Queue topped up to ${manifest.queue.length} article(s).`);
  } else {
    console.log('No articles written this run.');
  }
})();
