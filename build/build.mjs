#!/usr/bin/env node
// Learning Hub content builder — zero dependencies (marked is vendored).
// Usage:  node build/build.mjs           build once
//         node build/build.mjs --watch   rebuild on every change in content/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Marked } = require('./vendor/marked.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, 'dist', 'content.js');

const CALLOUTS = {
  tip: { tag: 'aside', label: 'Tip' },
  info: { tag: 'aside', label: 'Note' },
  warning: { tag: 'aside', label: 'Watch out' },
  mac: { tag: 'aside', label: 'On your Mac' },
  try: { tag: 'aside', label: 'Try it' },
  deep: { tag: 'details', label: 'Deep dive' },
  details: { tag: 'details', label: 'Details' },
  hint: { tag: 'details', label: 'Hint' },
  solution: { tag: 'details', label: 'Solution' },
};
const LEVELS = ['beginner', 'intermediate', 'advanced'];

// ---------- diagnostics ----------
let errors = [];
let warnings = [];
const err = (file, msg) => errors.push(`${rel(file)}: ${msg}`);
const warn = (file, msg) => warnings.push(`${rel(file)}: ${msg}`);
const rel = (f) => path.relative(ROOT, f);

// ---------- helpers ----------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) =>
  String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section';
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function readJson(file, required = true) {
  if (!fs.existsSync(file)) { if (required) err(file, 'missing file'); return null; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { err(file, `invalid JSON — ${e.message}`); return null; }
}
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null);

// ---------- markdown ----------
function makeRenderer(ids) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        let id = slugify(stripTags(inner));
        let n = 2; const base = id;
        while (ids.has(id)) id = `${base}-${n++}`;
        ids.add(id);
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
      code(token) {
        const lang = (token.lang || '').trim().split(/\s+/)[0].toLowerCase();
        const map = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', yml: 'yaml', tf: 'hcl', terraform: 'hcl', ts: 'typescript', js: 'javascript', Dockerfile: 'docker', dockerfile: 'docker', make: 'makefile' };
        const l = map[lang] || lang || 'text';
        return `<div class="code"><div class="code-bar"><span>${escapeHtml(lang || 'text')}</span><button class="copy" type="button">Copy</button></div><pre class="language-${l}"><code class="language-${l}">${escapeHtml(token.text)}</code></pre></div>\n`;
      },
    },
  });
  return marked;
}

function postProcess(html) {
  return html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');
}

/** Split markdown into plain chunks and ::: container blocks, respecting code fences. */
function splitBlocks(md, file) {
  const lines = md.split('\n');
  const out = [];
  let buf = [];
  let fence = null; // current fence marker e.g. ``` or ````
  let container = null;
  const flush = () => { if (buf.length) { out.push({ type: 'md', text: buf.join('\n') }); buf = []; } };
  lines.forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) fence = fm[1];
      else if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') fence = null;
    }
    if (!fence && !fm) {
      const open = line.match(/^:::([a-z]+)\s*(.*)$/);
      if (open && !container) {
        flush();
        container = { type: open[1], title: open[2].trim(), lines: [], line: i + 1 };
        return;
      }
      if (open && container) err(file, `line ${i + 1}: nested ":::${open[1]}" inside ":::${container.type}" (blocks cannot be nested)`);
      if (/^:::\s*$/.test(line)) {
        if (container) { out.push({ type: 'container', ...container, text: container.lines.join('\n') }); container = null; }
        else warn(file, `line ${i + 1}: stray closing ":::"`);
        return;
      }
    }
    (container ? container.lines : buf).push(line);
  });
  if (fence) err(file, 'unclosed code fence');
  if (container) err(file, `":::${container.type}" opened on line ${container.line} is never closed`);
  flush();
  return out;
}

function renderMarkdown(md, file, ids = new Set()) {
  const marked = makeRenderer(ids);
  const meta = {};
  let html = '';
  for (const block of splitBlocks(md, file)) {
    if (block.type === 'md') { html += marked.parse(block.text); continue; }
    if (block.type === 'meta') {
      block.text.split('\n').forEach((l) => { const m = l.match(/^\s*([\w-]+)\s*:\s*(.+)$/); if (m) meta[m[1].toLowerCase()] = m[2].trim(); });
      continue;
    }
    let def = CALLOUTS[block.type];
    if (!def) { warn(file, `unknown block ":::${block.type}" (rendered as a note)`); def = CALLOUTS.info; }
    const title = block.title ? marked.parseInline(block.title) : def.label;
    const inner = marked.parse(block.text);
    const cls = `callout callout-${CALLOUTS[block.type] ? block.type : 'info'}`;
    html += def.tag === 'details'
      ? `<details class="${cls}"><summary><span class="callout-label">${def.label}</span>${block.title ? `<span class="callout-title">${title}</span>` : ''}</summary><div class="callout-body">${inner}</div></details>\n`
      : `<aside class="${cls}"><div class="callout-head"><span class="callout-label">${def.label}</span>${block.title ? `<span class="callout-title">${title}</span>` : ''}</div><div class="callout-body">${inner}</div></aside>\n`;
  }
  return { html: postProcess(html), meta };
}

function tocFrom(html) {
  const toc = [];
  html.replace(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g, (_, d, id, inner) => { toc.push({ id, depth: Number(d), text: stripTags(inner) }); return ''; });
  return toc;
}

function inline(md) {
  const marked = new Marked({ gfm: true });
  return postProcess(marked.parseInline(String(md ?? '')));
}
function block(md) {
  const marked = new Marked({ gfm: true });
  return postProcess(marked.parse(String(md ?? '')));
}

/** Split labs.md into intro + labs on top-level `## ` headings (outside fences). */
function splitLabs(md) {
  const lines = md.split('\n');
  const parts = [{ title: null, lines: [] }];
  let fence = null;
  for (const line of lines) {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) { if (!fence) fence = fm[1]; else if (line.trim().replace(/[`~]/g, '') === '') fence = null; }
    const h = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h) parts.push({ title: h[1], lines: [] });
    else parts[parts.length - 1].lines.push(line);
  }
  return parts;
}

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

// ---------- builders ----------
function buildModule(trackId, dir) {
  const slug = path.basename(dir);
  const id = `${trackId}/${slug}`;
  const meta = readJson(path.join(dir, 'module.json'));
  if (!meta) return null;
  if (!meta.title) err(path.join(dir, 'module.json'), '"title" is required');
  if (meta.level && !LEVELS.includes(meta.level)) warn(path.join(dir, 'module.json'), `level "${meta.level}" should be one of ${LEVELS.join(', ')}`);
  (meta.resources || []).forEach((r, i) => { if (!/^https?:\/\//.test(r.url || '')) err(path.join(dir, 'module.json'), `resource #${i + 1} has an invalid url`); });

  const mod = {
    id, track: trackId, slug,
    title: meta.title || slug,
    summary: meta.summary || '',
    level: meta.level || 'beginner',
    estimatedMinutes: meta.estimatedMinutes || null,
    objectives: (meta.objectives || []).map(inline),
    resources: (meta.resources || []).map((r) => ({ title: r.title || r.url, url: r.url, type: r.type || 'docs', note: r.note ? inline(r.note) : '' })),
    lesson: null, labsIntro: '', labs: [], quiz: [], flashcards: [],
  };

  const lessonFile = path.join(dir, 'lesson.md');
  const lessonMd = readText(lessonFile);
  if (lessonMd == null) err(lessonFile, 'missing file');
  else {
    if (/^#\s/m.test(lessonMd.replace(/```[\s\S]*?```/g, ''))) warn(lessonFile, 'contains an H1 heading — use ## for sections');
    const { html } = renderMarkdown(lessonMd, lessonFile);
    mod.lesson = { html, toc: tocFrom(html), words: lessonMd.split(/\s+/).length };
  }

  const labsFile = path.join(dir, 'labs.md');
  const labsMd = readText(labsFile);
  if (labsMd != null) {
    const parts = splitLabs(labsMd);
    mod.labsIntro = renderMarkdown(parts[0].lines.join('\n'), labsFile).html;
    const seen = new Set();
    parts.slice(1).forEach((p) => {
      const ids = new Set();
      const { html, meta: m } = renderMarkdown(p.lines.join('\n'), labsFile, ids);
      let lid = slugify(p.title); let n = 2; const base = lid;
      while (seen.has(lid)) lid = `${base}-${n++}`;
      seen.add(lid);
      mod.labs.push({ id: lid, title: inline(p.title), difficulty: (m.difficulty || '').toLowerCase(), time: m.time || '', html });
    });
    if (!mod.labs.length) warn(labsFile, 'no labs found (each lab starts with a "## " heading)');
  }

  const quizFile = path.join(dir, 'quiz.json');
  const quiz = readJson(quizFile, false);
  if (quiz) {
    if (!Array.isArray(quiz)) err(quizFile, 'must be an array');
    else quiz.forEach((q, i) => {
      const where = `question ${i + 1}`;
      const type = q.type || (Array.isArray(q.answer) ? 'multi' : 'single');
      if (!q.q || !Array.isArray(q.options) || q.options.length < 2) return err(quizFile, `${where}: needs "q" and at least 2 "options"`);
      const answers = Array.isArray(q.answer) ? q.answer : [q.answer];
      if (type === 'single' && Array.isArray(q.answer)) err(quizFile, `${where}: single-choice answer must be a number`);
      if (answers.some((a) => !Number.isInteger(a) || a < 0 || a >= q.options.length)) return err(quizFile, `${where}: answer index out of range`);
      if (!q.explain) warn(quizFile, `${where}: no "explain"`);
      mod.quiz.push({ type, q: inline(q.q), options: q.options.map(inline), answer: answers, explain: block(q.explain || '') });
    });
  }

  const cardsFile = path.join(dir, 'flashcards.json');
  const cards = readJson(cardsFile, false);
  if (cards) {
    if (!Array.isArray(cards)) err(cardsFile, 'must be an array');
    else cards.forEach((c, i) => {
      if (!c.front || !c.back) return err(cardsFile, `card ${i + 1}: needs "front" and "back"`);
      mod.flashcards.push({ id: `${id}#${hash(c.front)}`, front: inline(c.front), back: block(c.back) });
    });
  }
  return mod;
}

function buildTrack(trackDir) {
  const id = path.basename(trackDir);
  const file = path.join(trackDir, 'track.json');
  const meta = readJson(file);
  if (!meta) return null;
  const track = {
    id,
    title: meta.title || id,
    tagline: meta.tagline || '',
    description: meta.description ? block(meta.description) : '',
    accent: meta.accent || '#0E5E6F',
    level: meta.level || '',
    prerequisites: meta.prerequisites || [],
    pages: [],
    modules: [],
  };
  for (const p of meta.pages || []) {
    const pf = path.join(trackDir, p.file || '');
    const md = readText(pf);
    if (md == null) { err(file, `page "${p.id}" points to missing file ${p.file}`); continue; }
    const { html } = renderMarkdown(md, pf);
    track.pages.push({ id: p.id || slugify(p.title), title: p.title || p.id, html, toc: tocFrom(html) });
  }
  const modules = fs.readdirSync(trackDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name).sort();
  const built = [];
  for (const m of modules) { const mod = buildModule(id, path.join(trackDir, m)); if (mod) built.push(mod); }
  track.modules = built.map((m) => m.id);
  return { track, modules: built };
}

function build() {
  errors = []; warnings = [];
  const t0 = Date.now();
  const catalogFile = path.join(CONTENT, 'catalog.json');
  const catalog = readJson(catalogFile) || { title: 'Learning Hub', groups: [] };
  const tracksDir = path.join(CONTENT, 'tracks');
  const data = { generatedAt: new Date().toISOString(), catalog, tracks: {}, modules: {} };
  for (const d of fs.readdirSync(tracksDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('_')) continue;
    const res = buildTrack(path.join(tracksDir, d.name));
    if (!res) continue;
    data.tracks[res.track.id] = res.track;
    res.modules.forEach((m) => { data.modules[m.id] = m; });
  }
  const listed = new Set();
  for (const g of catalog.groups || []) {
    g.tracks = (g.tracks || []).filter((t) => { listed.add(t); if (!data.tracks[t]) { err(catalogFile, `group "${g.id}" lists unknown track "${t}"`); return false; } return true; });
  }
  const orphans = Object.keys(data.tracks).filter((t) => !listed.has(t));
  if (orphans.length) {
    warn(catalogFile, `tracks not listed in any group were added to "Other topics": ${orphans.join(', ')}`);
    catalog.groups.push({ id: 'other', title: 'Other topics', description: '', tracks: orphans });
  }
  for (const t of Object.values(data.tracks)) t.prerequisites.forEach((p) => { if (!data.tracks[p]) warn(path.join(tracksDir, t.id, 'track.json'), `unknown prerequisite "${p}"`); });

  warnings.forEach((w) => console.warn(`  warn  ${w}`));
  errors.forEach((e) => console.error(`  error ${e}`));
  if (errors.length) { console.error(`\n✗ Build failed with ${errors.length} error(s). dist/content.js was not updated.`); return false; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
  fs.writeFileSync(OUT, `/* Generated by build/build.mjs — do not edit. Edit files in content/ and rebuild. */\nwindow.HUB_CONTENT = ${json};\n`);
  const mods = Object.values(data.modules);
  const count = (k) => mods.reduce((n, m) => n + m[k].length, 0);
  console.log(`✓ Built ${Object.keys(data.tracks).length} tracks, ${mods.length} modules, ${count('labs')} labs, ${count('quiz')} quiz questions, ${count('flashcards')} flashcards in ${Date.now() - t0} ms` + (warnings.length ? ` (${warnings.length} warning(s))` : ''));
  return true;
}

const ok = build();
if (process.argv.includes('--watch')) {
  console.log('Watching content/ for changes… (Ctrl+C to stop)');
  let timer = null;
  fs.watch(CONTENT, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(build, 150); });
} else if (!ok) process.exit(1);
