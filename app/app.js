/* Learning Hub — single-file app. Content comes from dist/content.js (window.HUB_CONTENT). */
(() => {
  'use strict';

  const DATA = window.HUB_CONTENT;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const main = $('#main');
  const sidebar = $('#sidebar');

  if (!DATA) {
    main.innerHTML = `<div class="page narrow"><h1 class="display">Content not built yet</h1>
      <p>Run <code>node build/build.mjs</code> in this folder, then refresh the page.</p></div>`;
    return;
  }

  // ---------------------------------------------------------------- storage
  const KEY = 'learning-hub:v1';
  const blank = () => ({ v: 1, theme: '', lessons: {}, labs: {}, quiz: {}, cards: {}, notes: {}, visited: {}, last: null, includeUnread: false });
  let S = blank();
  try { S = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* storage unavailable */ }
  let saveTimer = null;
  const save = (now) => {
    clearTimeout(saveTimer);
    const write = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Progress could not be saved in this browser.'); } };
    if (now) write(); else saveTimer = setTimeout(write, 200);
  };

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const strip = (html) => String(html).replace(/<\/?(code|strong|em|a|b|i|mark|span|kbd)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const track = (id) => DATA.tracks[id];
  const mod = (id) => DATA.modules[id];
  const modsOf = (tid) => (track(tid)?.modules || []).map(mod);
  const allTracks = () => DATA.catalog.groups.flatMap((g) => g.tracks.map(track));
  const DAY = 86400000;
  const fmtMin = (m) => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  const levelName = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
  const modNumber = (m) => { const n = parseInt(m.slug, 10); return Number.isNaN(n) ? '' : String(n).padStart(2, '0'); };
  const modHref = (m, tab = 'lesson', anchor) => `#/m/${m.id}/${tab}${anchor ? '@' + anchor : ''}`;

  function progress(m) {
    const lesson = !!S.lessons[m.id];
    const labsMap = S.labs[m.id] || {};
    const labsDone = m.labs.filter((l) => labsMap[l.id]).length;
    const labsTotal = m.labs.length;
    const q = S.quiz[m.id];
    const quizBest = q ? q.best : null;
    const parts = [[lesson ? 1 : 0, 0.3]];
    if (labsTotal) parts.push([labsDone / labsTotal, 0.45]);
    if (m.quiz.length) parts.push([quizBest == null ? 0 : Math.min(quizBest / 0.7, 1), 0.25]);
    const w = parts.reduce((a, [, x]) => a + x, 0);
    const pct = parts.reduce((a, [v, x]) => a + v * x, 0) / w;
    const done = lesson && labsDone === labsTotal && (!m.quiz.length || (quizBest ?? 0) >= 0.7);
    return { lesson, labsDone, labsTotal, quizBest, pct: done ? 1 : Math.min(pct, 0.99), done, started: pct > 0 };
  }
  const trackProgress = (tid) => {
    const ms = modsOf(tid);
    if (!ms.length) return { pct: 0, done: 0, total: 0 };
    const ps = ms.map(progress);
    return { pct: ps.reduce((a, p) => a + p.pct, 0) / ms.length, done: ps.filter((p) => p.done).length, total: ms.length };
  };

  function nextStep(m) {
    const p = progress(m);
    if (!p.lesson) return { label: 'Read the lesson', href: modHref(m, 'lesson') };
    if (p.labsDone < p.labsTotal) return { label: `Do the labs (${p.labsDone}/${p.labsTotal} done)`, href: modHref(m, 'labs') };
    if (m.quiz.length && (p.quizBest ?? 0) < 0.7) return { label: 'Take the quiz', href: modHref(m, 'quiz') };
    const ms = modsOf(m.track); const nx = ms[ms.indexOf(m) + 1];
    if (nx) return { label: `Start ${nx.title}`, href: modHref(nx, 'lesson'), mod: nx };
    return { label: 'Track complete. Review your cards', href: '#/review' };
  }

  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------------------------------------------------------------- cargo row (signature element)
  function cargo(tid, { size = '', link = true, current } = {}) {
    const t = track(tid);
    return `<div class="cargo ${size}" style="--accent:${t.accent}" role="list" aria-label="${esc(t.title)} modules">${modsOf(tid).map((m) => {
      const p = progress(m);
      const cls = ['box', p.done ? 'is-done' : '', p.started && !p.done ? 'is-started' : '', current === m.id ? 'is-current' : ''].join(' ');
      const label = `${modNumber(m)} ${m.title}: ${p.done ? 'complete' : Math.round(p.pct * 100) + '%'}`;
      const inner = `<span class="fill" style="--p:${p.pct}"></span>`;
      return link ? `<a role="listitem" class="${cls}" href="${modHref(m)}" title="${esc(label)}" aria-label="${esc(label)}">${inner}</a>`
        : `<span role="listitem" class="${cls}" title="${esc(label)}">${inner}</span>`;
    }).join('')}</div>`;
  }

  // ---------------------------------------------------------------- cards (spaced repetition)
  const INTERVALS = [0, 1, 2, 4, 8, 16, 32, 64];
  function allCards(filterTrack) {
    return allTracks().flatMap((t) => modsOf(t.id))
      .filter((m) => !filterTrack || m.track === filterTrack)
      .flatMap((m) => m.flashcards.map((c) => ({ ...c, mod: m })));
  }
  function dueCards(filterTrack) {
    const now = Date.now();
    return allCards(filterTrack).filter((c) => {
      const st = S.cards[c.id];
      if (st) return st.due <= now;
      return S.includeUnread || S.lessons[c.mod.id];
    });
  }
  function grade(card, g) {
    const st = S.cards[card.id] || { box: 0, due: 0, reps: 0 };
    st.reps = (st.reps || 0) + 1;
    if (g === 'again') { st.box = 1; st.due = Date.now() + 60 * 1000; }
    else if (g === 'hard') { st.box = Math.max(1, st.box); st.due = Date.now() + DAY; }
    else if (g === 'good') { st.box = Math.min(st.box + 1, INTERVALS.length - 1); st.due = Date.now() + INTERVALS[st.box] * DAY; }
    else if (g === 'easy') { st.box = Math.min(st.box + 2, INTERVALS.length - 1); st.due = Date.now() + INTERVALS[st.box] * DAY; }
    S.cards[card.id] = st; save();
  }

  // ---------------------------------------------------------------- sidebar
  function renderSidebar(ctx = {}) {
    const due = dueCards().length;
    const groups = DATA.catalog.groups.map((g) => `
      <div class="nav-group">
        <div class="nav-group-title">${esc(g.title)}</div>
        ${g.tracks.map((tid) => {
          const t = track(tid); const tp = trackProgress(tid); const open = ctx.track === tid;
          return `<div class="nav-track ${open ? 'is-open' : ''}" style="--accent:${t.accent}">
            <a class="nav-track-link ${ctx.track === tid && !ctx.module ? 'is-active' : ''}" href="#/t/${tid}">
              <span class="swatch"></span><span class="nav-track-name">${esc(t.title)}</span><span class="nav-pct">${Math.round(tp.pct * 100)}%</span></a>
            ${open ? `<ol class="nav-modules">${modsOf(tid).map((m) => {
              const p = progress(m);
              return `<li><a class="${ctx.module === m.id ? 'is-active' : ''} ${p.done ? 'is-done' : ''}" href="${modHref(m)}">
                <span class="nav-num">${modNumber(m)}</span><span class="nav-mod-title">${esc(m.title)}</span>${p.done ? '<span class="tick" aria-label="complete">✓</span>' : ''}</a></li>`;
            }).join('')}</ol>` : ''}
          </div>`;
        }).join('')}
      </div>`).join('');
    sidebar.innerHTML = `
      <div class="nav-top">
        <a class="nav-link ${ctx.view === 'home' ? 'is-active' : ''}" href="#/">Home</a>
        <a class="nav-link ${ctx.view === 'review' ? 'is-active' : ''}" href="#/review">Review cards ${due ? `<span class="badge">${due}</span>` : ''}</a>
        <a class="nav-link ${ctx.view === 'progress' ? 'is-active' : ''}" href="#/progress">Progress &amp; backup</a>
      </div>
      ${groups}
      <div class="nav-foot">
        <button class="theme-btn" type="button" data-action="theme">${themeLabel()}</button>
      </div>`;
  }
  function themeLabel() { return { '': 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }[S.theme || '']; }

  // ---------------------------------------------------------------- views
  function viewHome() {
    renderSidebar({ view: 'home' });
    const lastMod = S.last && mod(S.last);
    const due = dueCards().length;
    const totals = Object.values(DATA.modules).reduce((a, m) => { const p = progress(m); a.done += p.done ? 1 : 0; a.labs += p.labsDone; a.labsTotal += p.labsTotal; return a; }, { done: 0, labs: 0, labsTotal: 0 });
    const firstTrack = DATA.catalog.groups[0]?.tracks[0];
    let startMod = lastMod || (firstTrack && modsOf(firstTrack)[0]);
    let step = startMod && nextStep(startMod);
    if (step?.mod) { startMod = step.mod; step = nextStep(startMod); }
    const greeting = (() => { const h = new Date().getHours(); return h < 5 ? 'Late night session' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();

    main.innerHTML = `
      <div class="page home">
        <section class="hero">
          <p class="hero-kicker">${greeting}${DATA.catalog.owner ? `, ${esc(DATA.catalog.owner)}` : ''}.</p>
          <h1 class="display">${lastMod ? 'Pick up where you left off.' : 'Learn it by running it.'}</h1>
          ${step ? `<div class="continue" style="--accent:${track(startMod.track).accent}">
            <div class="continue-where"><span class="continue-track">${esc(track(startMod.track).title)} ${modNumber(startMod)}</span>
              <a class="continue-title" href="${modHref(startMod)}">${esc(startMod.title)}</a></div>
            <a class="btn primary" href="${step.href}">${esc(step.label)}</a>
          </div>` : ''}
          <dl class="stats">
            <div><dt>Modules complete</dt><dd>${totals.done}<small> / ${Object.keys(DATA.modules).length}</small></dd></div>
            <div><dt>Labs done</dt><dd>${totals.labs}<small> / ${totals.labsTotal}</small></dd></div>
            <div><dt>Cards due</dt><dd><a href="#/review">${due}</a></dd></div>
          </dl>
        </section>

        ${DATA.catalog.groups.map((g) => `
          <section class="group">
            <header class="group-head"><h2>${esc(g.title)}</h2>${g.description ? `<p>${esc(g.description)}</p>` : ''}</header>
            <div class="manifest">
              ${g.tracks.map((tid) => { const t = track(tid); const tp = trackProgress(tid); const ms = modsOf(tid);
                const minutes = ms.reduce((a, m) => a + (m.estimatedMinutes || 0), 0);
                return `<article class="manifest-row" style="--accent:${t.accent}">
                  <div class="manifest-info">
                    <h3><a href="#/t/${tid}">${esc(t.title)}</a></h3>
                    <p>${esc(t.tagline)}</p>
                    <p class="meta">${ms.length} modules, about ${Math.round(minutes / 60)} hours${t.prerequisites.length ? `. After ${t.prerequisites.map((p) => esc(track(p)?.title || p)).join(', ')}` : ''}</p>
                  </div>
                  <div class="manifest-cargo">${cargo(tid)}<span class="manifest-pct">${tp.done}/${tp.total} complete</span></div>
                </article>`; }).join('')}
            </div>
          </section>`).join('')}

        <section class="method">
          <h2>How each module works</h2>
          <ol class="method-steps">
            <li><strong>Lesson.</strong> Build the mental model first. Run every <em>Try it</em> box as you read.</li>
            <li><strong>Labs.</strong> Do them on your Mac without peeking. Open the hint after ten stuck minutes, the solution only after you have a working answer or are truly stuck.</li>
            <li><strong>Quiz.</strong> Score 70% or more to complete the module. Read every explanation, including for answers you got right.</li>
            <li><strong>Review.</strong> Cards from modules you have read join your daily review. Five minutes a day keeps it all in your head.</li>
          </ol>
        </section>
      </div>`;
  }

  function viewTrack(tid, pageId) {
    const t = track(tid);
    if (!t) return viewNotFound();
    renderSidebar({ track: tid });
    const ms = modsOf(tid);
    const tp = trackProgress(tid);
    const page = pageId && t.pages.find((p) => p.id === pageId);
    const tabs = `<nav class="tabs" aria-label="Track sections">
      <a href="#/t/${tid}" class="${!page ? 'is-active' : ''}">Modules</a>
      ${t.pages.map((p) => `<a href="#/t/${tid}/p/${p.id}" class="${page?.id === p.id ? 'is-active' : ''}">${esc(p.title)}</a>`).join('')}
    </nav>`;
    const body = page ? `<div class="with-toc"><article class="prose">${page.html}</article>${tocHtml(page.toc)}</div>` : `
      <ol class="module-list">${ms.map((m) => { const p = progress(m);
        return `<li class="module-item ${p.done ? 'is-done' : ''}">
          <a href="${modHref(m)}" class="module-link">
            <span class="module-num">${modNumber(m)}</span>
            <span class="module-main">
              <span class="module-title">${esc(m.title)}</span>
              <span class="module-summary">${esc(m.summary)}</span>
              <span class="module-meta"><span class="lvl lvl-${m.level}">${levelName[m.level] || m.level}</span>${m.estimatedMinutes ? `<span>${fmtMin(m.estimatedMinutes)}</span>` : ''}<span>${m.labs.length} labs</span><span>${m.quiz.length} questions</span></span>
            </span>
            <span class="module-status">
              <span class="chk ${p.lesson ? 'on' : ''}">Lesson</span>
              <span class="chk ${p.labsTotal && p.labsDone === p.labsTotal ? 'on' : ''}">Labs ${p.labsDone}/${p.labsTotal}</span>
              <span class="chk ${(p.quizBest ?? 0) >= 0.7 ? 'on' : ''}">Quiz ${p.quizBest == null ? 'not taken' : Math.round(p.quizBest * 100) + '%'}</span>
            </span>
          </a></li>`; }).join('')}
      </ol>`;
    main.innerHTML = `
      <div class="page track-page" style="--accent:${t.accent}">
        <header class="track-head">
          <p class="crumbs"><a href="#/">Home</a></p>
          <h1 class="display">${esc(t.title)}</h1>
          <p class="lede">${esc(t.tagline)}</p>
          <div class="track-desc">${t.description}</div>
          ${t.prerequisites.length ? `<p class="meta">Do first: ${t.prerequisites.map((p) => `<a href="#/t/${p}">${esc(track(p)?.title || p)}</a>`).join(', ')}</p>` : ''}
          <div class="track-cargo">${cargo(tid, { size: 'lg' })}<span class="manifest-pct">${tp.done} of ${tp.total} modules complete, ${Math.round(tp.pct * 100)}% overall</span></div>
        </header>
        ${tabs}
        ${body}
      </div>`;
    afterRender();
  }

  function tocHtml(toc) {
    const items = (toc || []).filter((x) => x.depth === 2);
    if (items.length < 2) return '<div></div>';
    return `<aside class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ol>${items.map((x) => `<li><a href="#" data-anchor="${x.id}">${esc(x.text)}</a></li>`).join('')}</ol></aside>`;
  }

  const quizState = {};

  function viewModule(tid, slug, tab = 'lesson', anchor) {
    const m = mod(`${tid}/${slug}`);
    if (!m) return viewNotFound();
    const t = track(tid);
    S.last = m.id; S.visited[m.id] = Date.now(); save();
    renderSidebar({ track: tid, module: m.id });
    const p = progress(m);
    const ms = modsOf(tid); const idx = ms.indexOf(m); const prev = ms[idx - 1]; const next = ms[idx + 1];
    const tabs = [
      ['lesson', 'Lesson', p.lesson ? '✓' : ''],
      ['labs', 'Labs', m.labs.length ? `${p.labsDone}/${m.labs.length}` : ''],
      ['quiz', 'Quiz', m.quiz.length ? (p.quizBest == null ? String(m.quiz.length) : Math.round(p.quizBest * 100) + '%') : ''],
      ['cards', 'Cards', m.flashcards.length ? String(m.flashcards.length) : ''],
      ['resources', 'Resources', String(m.resources.length)],
      ['notes', 'Notes', S.notes[m.id] ? '•' : ''],
    ].filter(([k]) => !(k === 'labs' && !m.labs.length) && !(k === 'quiz' && !m.quiz.length) && !(k === 'cards' && !m.flashcards.length));
    if (!tabs.find(([k]) => k === tab)) tab = 'lesson';

    let body = '';
    if (tab === 'lesson') body = lessonBody(m, p, next);
    else if (tab === 'labs') body = labsBody(m);
    else if (tab === 'quiz') body = `<div class="quiz" id="quiz"></div>`;
    else if (tab === 'cards') body = cardsBody(m);
    else if (tab === 'resources') body = resourcesBody(m);
    else if (tab === 'notes') body = notesBody(m);

    main.innerHTML = `
      <div class="page module-page" style="--accent:${t.accent}">
        <header class="module-head">
          <p class="crumbs"><a href="#/t/${tid}">${esc(t.title)}</a><span aria-hidden="true">/</span><span>Module ${modNumber(m)}</span></p>
          <h1 class="display">${esc(m.title)}</h1>
          <p class="lede">${esc(m.summary)}</p>
          <p class="module-facts"><span class="lvl lvl-${m.level}">${levelName[m.level] || m.level}</span>${m.estimatedMinutes ? `<span>About ${fmtMin(m.estimatedMinutes)}</span>` : ''}<span>${Math.round(p.pct * 100)}% done</span></p>
          ${cargo(tid, { current: m.id })}
        </header>
        <nav class="tabs sticky-tabs" aria-label="Module sections">${tabs.map(([k, label, badge]) => `<a href="${modHref(m, k)}" class="${tab === k ? 'is-active' : ''}" ${tab === k ? 'aria-current="page"' : ''}>${label}${badge ? ` <span class="tab-badge">${badge}</span>` : ''}</a>`).join('')}</nav>
        <div class="tab-body tab-${tab}">${body}</div>
        <nav class="pager" aria-label="Modules">
          ${prev ? `<a class="pager-prev" href="${modHref(prev)}"><span>Previous module</span>${esc(prev.title)}</a>` : '<span></span>'}
          ${next ? `<a class="pager-next" href="${modHref(next)}"><span>Next module</span>${esc(next.title)}</a>` : '<span></span>'}
        </nav>
      </div>`;
    if (tab === 'quiz') renderQuiz(m);
    if (tab === 'notes') bindNotes(m);
    afterRender(anchor);
  }

  function lessonBody(m, p, next) {
    return `
      ${m.objectives.length ? `<section class="objectives"><h2>By the end you can</h2><ul>${m.objectives.map((o) => `<li>${o}</li>`).join('')}</ul></section>` : ''}
      <div class="with-toc">
        <article class="prose">${m.lesson?.html || '<p>No lesson yet.</p>'}
          <div class="lesson-end">
            <button class="btn ${p.lesson ? '' : 'primary'}" type="button" data-action="toggle-read" data-mod="${m.id}">${p.lesson ? 'Marked as read. Undo' : 'Mark lesson as read'}</button>
            ${m.labs.length ? `<a class="btn" href="${modHref(m, 'labs')}">Go to the labs</a>` : next ? `<a class="btn" href="${modHref(next)}">Next module</a>` : ''}
          </div>
        </article>
        ${tocHtml(m.lesson?.toc)}
      </div>`;
  }

  function labsBody(m) {
    const done = S.labs[m.id] || {};
    const diff = (d) => (d ? `<span class="diff diff-${esc(d.split(/\s/)[0])}">${esc(d)}</span>` : '');
    return `
      <div class="labs">
        <ol class="lab-index">${m.labs.map((l, i) => `<li class="${done[l.id] ? 'is-done' : ''}"><a href="#" data-anchor="lab-${l.id}"><span class="lab-n">${i + 1}</span><span class="lab-t">${l.title}</span>${diff(l.difficulty)}${l.time ? `<span class="lab-time">${esc(l.time)}</span>` : ''}</a></li>`).join('')}</ol>
        ${m.labsIntro.trim() ? `<div class="prose labs-intro">${m.labsIntro}</div>` : ''}
        ${m.labs.map((l, i) => `
          <section class="lab ${done[l.id] ? 'is-done' : ''}" id="lab-${l.id}">
            <header class="lab-head">
              <span class="lab-n">${i + 1}</span>
              <h2>${l.title}</h2>
              <span class="lab-tags">${diff(l.difficulty)}${l.time ? `<span class="lab-time">${esc(l.time)}</span>` : ''}</span>
            </header>
            <div class="prose">${l.html}</div>
            <footer class="lab-foot"><button type="button" class="btn ${done[l.id] ? '' : 'primary'}" data-action="toggle-lab" data-mod="${m.id}" data-lab="${l.id}" aria-pressed="${!!done[l.id]}">${done[l.id] ? 'Done. Mark as not done' : 'Mark lab as done'}</button></footer>
          </section>`).join('')}
      </div>`;
  }

  function cardsBody(m) {
    return `
      <p class="tab-intro">Tap a card to flip it. These cards also join your <a href="#/review">daily review</a> once you mark the lesson as read.</p>
      <div class="flip-grid">${m.flashcards.map((c) => `
        <button class="flip" type="button" data-action="flip">
          <span class="flip-front">${c.front}</span>
          <span class="flip-back">${c.back}</span>
        </button>`).join('')}</div>`;
  }

  function resourcesBody(m) {
    const typeName = { docs: 'Docs', article: 'Article', video: 'Video', book: 'Book', tool: 'Tool', course: 'Course', spec: 'Spec' };
    return `<p class="tab-intro">Original sources for going deeper. Official documentation first.</p>
      <ul class="resources">${m.resources.map((r) => `<li>
        <a href="${esc(r.url)}" target="_blank" rel="noopener"><span class="res-type">${typeName[r.type] || esc(r.type)}</span><span class="res-title">${esc(r.title)}</span><span class="res-host">${esc((() => { try { return new URL(r.url).host.replace(/^www\./, ''); } catch (e) { return ''; } })())}</span></a>
        ${r.note ? `<p>${r.note}</p>` : ''}</li>`).join('')}</ul>`;
  }

  function notesBody(m) {
    return `<p class="tab-intro">Your own notes for this module: what clicked, commands to remember, questions to revisit. Saved in this browser as you type. Back them up from <a href="#/progress">Progress &amp; backup</a>.</p>
      <textarea class="notes" id="notes" spellcheck="true" placeholder="Write in your own words. Explaining it is how you find the gaps.">${esc(S.notes[m.id] || '')}</textarea>
      <p class="meta" id="notes-status"></p>`;
  }
  function bindNotes(m) {
    const ta = $('#notes'); const st = $('#notes-status');
    ta.addEventListener('input', () => { S.notes[m.id] = ta.value; if (!ta.value) delete S.notes[m.id]; save(); st.textContent = 'Saved'; });
  }

  // ---------------------------------------------------------------- quiz
  function renderQuiz(m) {
    const el = $('#quiz');
    let st = quizState[m.id];
    if (!st) st = quizState[m.id] = { i: 0, picks: m.quiz.map(() => []), checked: m.quiz.map(() => false), finished: false };
    const n = m.quiz.length;
    const isRight = (qi) => { const q = m.quiz[qi]; const a = [...st.picks[qi]].sort().join(); return a === [...q.answer].sort().join(); };

    if (st.finished) {
      const score = st.checked.filter((_, qi) => isRight(qi)).length / n;
      const prev = S.quiz[m.id];
      const wrong = m.quiz.map((q, qi) => ({ q, qi })).filter(({ qi }) => !isRight(qi));
      el.innerHTML = `
        <div class="quiz-result ${score >= 0.7 ? 'pass' : 'fail'}">
          <p class="quiz-score">${Math.round(score * 100)}%</p>
          <p>${score >= 0.7 ? 'Passed. The quiz part of this module is complete.' : 'You need 70% to complete the module. Reread the sections behind the questions below, then try again.'}</p>
          <p class="meta">Best score ${Math.round((prev?.best ?? score) * 100)}%, ${prev?.attempts || 1} attempt${(prev?.attempts || 1) > 1 ? 's' : ''}</p>
          <div class="quiz-actions"><button class="btn primary" type="button" data-action="quiz-restart">Try again</button>${score >= 0.7 ? nextLink(m) : ''}</div>
        </div>
        ${wrong.length ? `<h2 class="quiz-review-title">Questions to revisit</h2>${wrong.map(({ q, qi }) => `
          <div class="quiz-review">
            <p class="quiz-q">${q.q}</p>
            <ul>${q.options.map((o, oi) => `<li class="${q.answer.includes(oi) ? 'is-answer' : ''} ${st.picks[qi].includes(oi) && !q.answer.includes(oi) ? 'is-wrong' : ''}">${o}</li>`).join('')}</ul>
            <div class="quiz-explain">${q.explain}</div>
          </div>`).join('')}` : ''}`;
      return;
    }

    const qi = st.i; const q = m.quiz[qi]; const checked = st.checked[qi]; const picks = st.picks[qi];
    const multi = q.type === 'multi';
    el.innerHTML = `
      <div class="quiz-progress" aria-hidden="true">${m.quiz.map((_, k) => `<span class="${k === qi ? 'is-current' : ''} ${st.checked[k] ? (isRight(k) ? 'is-right' : 'is-wrong') : ''}"></span>`).join('')}</div>
      <p class="quiz-count">Question ${qi + 1} of ${n}${multi ? '. Select all that apply.' : ''}</p>
      <div class="quiz-q">${q.q}</div>
      <div class="quiz-options" role="${multi ? 'group' : 'radiogroup'}">
        ${q.options.map((o, oi) => {
          let cls = picks.includes(oi) ? 'is-picked' : '';
          if (checked) { if (q.answer.includes(oi)) cls += ' is-answer'; else if (picks.includes(oi)) cls += ' is-wrong'; }
          return `<button type="button" class="opt ${cls}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${picks.includes(oi)}" data-action="quiz-pick" data-oi="${oi}" ${checked ? 'disabled' : ''}>
            <span class="opt-key">${multi ? (picks.includes(oi) ? '■' : '□') : String.fromCharCode(65 + oi)}</span><span class="opt-text">${o}</span></button>`;
        }).join('')}
      </div>
      ${checked ? `<div class="quiz-feedback ${isRight(qi) ? 'right' : 'wrong'}"><p class="quiz-verdict">${isRight(qi) ? 'Correct.' : 'Not quite.'}</p><div class="quiz-explain">${q.explain}</div></div>` : ''}
      <div class="quiz-actions">
        ${qi > 0 ? '<button class="btn" type="button" data-action="quiz-prev">Previous</button>' : ''}
        ${!checked ? `<button class="btn primary" type="button" data-action="quiz-check" ${picks.length ? '' : 'disabled'}>Check answer</button>`
          : qi < n - 1 ? '<button class="btn primary" type="button" data-action="quiz-next">Next question</button>'
          : '<button class="btn primary" type="button" data-action="quiz-finish">See results</button>'}
      </div>
      <p class="kbd-hint">Keys: <kbd>A</kbd>–<kbd>${String.fromCharCode(64 + q.options.length)}</kbd> pick, <kbd>Enter</kbd> check or continue</p>`;
    el.dataset.mod = m.id;
  }
  function nextLink(m) { const s = nextStep(m); return `<a class="btn" href="${s.href}">${esc(s.label)}</a>`; }
  function quizAction(action, oi) {
    const m = mod($('#quiz')?.dataset.mod); if (!m) return;
    const st = quizState[m.id]; const q = m.quiz[st.i];
    if (action === 'quiz-pick') {
      if (st.checked[st.i]) return;
      const picks = st.picks[st.i];
      if (q.type === 'multi') { const k = picks.indexOf(oi); if (k >= 0) picks.splice(k, 1); else picks.push(oi); }
      else st.picks[st.i] = [oi];
    }
    if (action === 'quiz-check' && st.picks[st.i].length) st.checked[st.i] = true;
    if (action === 'quiz-next') st.i = Math.min(st.i + 1, m.quiz.length - 1);
    if (action === 'quiz-prev') st.i = Math.max(st.i - 1, 0);
    if (action === 'quiz-finish') {
      st.finished = true;
      const right = m.quiz.filter((qq, qi) => [...st.picks[qi]].sort().join() === [...qq.answer].sort().join()).length;
      const score = right / m.quiz.length;
      const prev = S.quiz[m.id] || { best: 0, attempts: 0 };
      S.quiz[m.id] = { best: Math.max(prev.best, score), last: score, attempts: prev.attempts + 1, at: Date.now() };
      save(true);
      renderSidebar({ track: m.track, module: m.id });
      refreshTabs(m);
    }
    if (action === 'quiz-restart') delete quizState[m.id];
    renderQuiz(m);
    if (action === 'quiz-finish' || action === 'quiz-restart' || action === 'quiz-next' || action === 'quiz-prev') $('.sticky-tabs')?.scrollIntoView({ block: 'start' });
    if (action !== 'quiz-pick') $('#quiz .quiz-actions .btn.primary:not([disabled])')?.focus({ preventScroll: true });
  }
  function refreshTabs(m) {
    // re-render module header numbers without losing quiz state
    const r = parseRoute();
    if (r.view === 'module') {
      const y = window.scrollY; viewModule(m.track, m.slug, r.tab); window.scrollTo(0, y);
    }
  }

  // ---------------------------------------------------------------- review
  let session = null;
  function viewReview(filter = '') {
    renderSidebar({ view: 'review' });
    const tracksWithCards = allTracks().filter((t) => allCards(t.id).length);
    if (!session || session.filter !== filter) {
      const due = dueCards(filter);
      const seen = due.filter((c) => S.cards[c.id]).sort((a, b) => S.cards[a.id].due - S.cards[b.id].due);
      const fresh = due.filter((c) => !S.cards[c.id]).slice(0, 25);
      session = { filter, queue: [...seen, ...fresh], done: 0, flipped: false };
    }
    const total = allCards(filter).length;
    const learned = allCards(filter).filter((c) => (S.cards[c.id]?.box || 0) >= 3).length;
    const card = session.queue[0];
    main.innerHTML = `
      <div class="page review narrow">
        <header>
          <p class="crumbs"><a href="#/">Home</a></p>
          <h1 class="display">Review</h1>
          <p class="lede">Spaced repetition: cards you know come back less often, cards you miss come back soon.</p>
        </header>
        <div class="review-bar">
          <label>Deck <select id="deck">${['', ...tracksWithCards.map((t) => t.id)].map((id) => `<option value="${id}" ${id === filter ? 'selected' : ''}>${id ? esc(track(id).title) : 'All tracks'}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" id="unread" ${S.includeUnread ? 'checked' : ''}> Include modules I haven't read</label>
          <span class="meta">${learned} of ${total} cards well known</span>
        </div>
        ${card ? `
          <div class="review-card ${session.flipped ? 'is-flipped' : ''}" style="--accent:${track(card.mod.track).accent}">
            <p class="review-src"><a href="${modHref(card.mod, 'lesson')}">${esc(track(card.mod.track).title)} ${modNumber(card.mod)}: ${esc(card.mod.title)}</a><span>${session.queue.length} left</span></p>
            <div class="review-front">${card.front}</div>
            ${session.flipped ? `<div class="review-back">${card.back}</div>` : ''}
          </div>
          <div class="review-actions">
            ${session.flipped ? `
              <button class="btn g-again" type="button" data-action="grade" data-g="again"><kbd>1</kbd> Again</button>
              <button class="btn g-hard" type="button" data-action="grade" data-g="hard"><kbd>2</kbd> Hard</button>
              <button class="btn primary g-good" type="button" data-action="grade" data-g="good"><kbd>3</kbd> Good</button>
              <button class="btn g-easy" type="button" data-action="grade" data-g="easy"><kbd>4</kbd> Easy</button>`
            : `<button class="btn primary wide" type="button" data-action="reveal"><kbd>Space</kbd> Show answer</button>`}
          </div>
          <p class="kbd-hint">Say the answer out loud before you reveal it.</p>`
        : `<div class="empty">
            <h2>${session.done ? `Done for now: ${session.done} card${session.done > 1 ? 's' : ''} reviewed.` : 'No cards due.'}</h2>
            <p>${Object.keys(S.lessons).length || S.includeUnread ? 'Come back tomorrow. Cards reappear when they are due.' : 'Cards appear here after you mark a lesson as read, or tick "Include modules I haven\'t read" above.'}</p>
            <a class="btn primary" href="${S.last ? modHref(mod(S.last)) : '#/'}">${S.last ? 'Back to your module' : 'Go to the modules'}</a>
          </div>`}
      </div>`;
    $('#deck').addEventListener('change', (e) => { session = null; location.hash = `#/review${e.target.value ? '/' + e.target.value : ''}`; });
    $('#unread').addEventListener('change', (e) => { S.includeUnread = e.target.checked; save(); session = null; viewReview(filter); });
  }
  function reviewAction(action, g) {
    if (!session || !session.queue.length) return;
    if (action === 'reveal') session.flipped = true;
    if (action === 'grade') {
      const card = session.queue.shift();
      grade(card, g);
      if (g === 'again') session.queue.push(card);
      session.done++; session.flipped = false;
    }
    viewReview(session.filter);
  }

  // ---------------------------------------------------------------- progress / backup
  function viewProgress() {
    renderSidebar({ view: 'progress' });
    const rows = allTracks().map((t) => {
      const ms = modsOf(t.id); const tp = trackProgress(t.id);
      const quizzes = ms.map((m) => S.quiz[m.id]?.best).filter((x) => x != null);
      const labs = ms.reduce((a, m) => { const p = progress(m); return [a[0] + p.labsDone, a[1] + p.labsTotal]; }, [0, 0]);
      return `<tr style="--accent:${t.accent}"><th scope="row"><a href="#/t/${t.id}">${esc(t.title)}</a></th><td>${cargo(t.id, { size: 'sm' })}</td><td>${tp.done}/${tp.total}</td><td>${labs[0]}/${labs[1]}</td><td>${quizzes.length ? Math.round((quizzes.reduce((a, b) => a + b, 0) / quizzes.length) * 100) + '%' : 'none'}</td></tr>`;
    }).join('');
    main.innerHTML = `
      <div class="page narrow progress-page">
        <header><p class="crumbs"><a href="#/">Home</a></p><h1 class="display">Progress &amp; backup</h1>
        <p class="lede">Progress lives in this browser's local storage. Export it now and then so you never lose your notes and review history.</p></header>
        <div class="table-wrap"><table class="progress-table"><thead><tr><th>Track</th><th>Modules</th><th>Complete</th><th>Labs</th><th>Avg. quiz</th></tr></thead><tbody>${rows}</tbody></table></div>
        <section class="backup">
          <h2>Backup</h2>
          <div class="backup-actions">
            <button class="btn primary" type="button" data-action="export">Export progress</button>
            <label class="btn">Import progress<input type="file" id="import" accept="application/json" hidden></label>
            <button class="btn danger" type="button" data-action="reset">Reset all progress</button>
          </div>
          <p class="meta">Content built ${new Date(DATA.generatedAt).toLocaleString()}.</p>
        </section>
        <section class="howto prose">
          <h2>Adding new topics</h2>
          <p>Everything in this hub comes from the <code>content/</code> folder. To add a topic, create <code>content/tracks/&lt;topic&gt;/</code> with a <code>track.json</code> and module folders, list it in <code>content/catalog.json</code>, then run <code>node build/build.mjs</code> and refresh. The full format is in <code>CONTENT_GUIDE.md</code>.</p>
        </section>
      </div>`;
    $('#import').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then((txt) => { const d = JSON.parse(txt); if (!d || d.v !== 1) throw new Error('bad file'); S = Object.assign(blank(), d); save(true); toast('Progress imported'); viewProgress(); })
        .catch(() => toast('That file is not a Learning Hub export.'));
    });
  }

  function viewNotFound() {
    renderSidebar({});
    main.innerHTML = `<div class="page narrow"><h1 class="display">Nothing here</h1><p>That page doesn't exist. It may have been renamed when content was rebuilt.</p><a class="btn primary" href="#/">Go home</a></div>`;
  }

  // ---------------------------------------------------------------- search
  let index = null;
  function buildIndex() {
    index = [];
    const sections = (html, base) => {
      const parts = html.split(/(?=<h[23] id=")/);
      return parts.map((part) => {
        const h = part.match(/^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/);
        return { id: h ? h[1] : '', title: h ? strip(h[2]) : base, text: strip(h ? part.slice(h[0].length) : part) };
      }).filter((s) => s.text || s.id);
    };
    for (const t of allTracks()) {
      for (const p of t.pages) sections(p.html, p.title).forEach((s) => index.push({ title: s.title, crumb: `${t.title}, ${p.title}`, href: `#/t/${t.id}/p/${p.id}${s.id ? '@' + s.id : ''}`, text: s.text, kind: 'Page' }));
      for (const m of modsOf(t.id)) {
        const crumb = `${t.title} ${modNumber(m)}, ${m.title}`;
        index.push({ title: m.title, crumb: t.title, href: modHref(m), text: m.summary, kind: 'Module', boost: 3 });
        if (m.lesson) sections(m.lesson.html, m.title).forEach((s) => index.push({ title: s.title, crumb, href: modHref(m, 'lesson', s.id), text: s.text, kind: 'Lesson' }));
        m.labs.forEach((l) => index.push({ title: strip(l.title), crumb, href: modHref(m, 'labs', 'lab-' + l.id), text: strip(l.html), kind: 'Lab' }));
        m.flashcards.forEach((c) => index.push({ title: strip(c.front), crumb, href: modHref(m, 'cards'), text: strip(c.back), kind: 'Card' }));
      }
    }
    index.forEach((e) => { e.lt = e.title.toLowerCase(); e.lx = e.text.toLowerCase(); });
  }
  function search(q) {
    if (!index) buildIndex();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const res = [];
    for (const e of index) {
      let score = 0; let ok = true;
      for (const t of terms) {
        const inT = e.lt.includes(t); const inX = e.lx.includes(t);
        if (!inT && !inX) { ok = false; break; }
        score += (inT ? 10 : 0) + (inX ? 1 + Math.min(5, e.lx.split(t).length - 1) * 0.2 : 0);
      }
      if (ok) res.push({ e, score: score * (e.boost || 1) });
    }
    return res.sort((a, b) => b.score - a.score).slice(0, 40).map((r) => r.e);
  }
  function snippet(text, terms) {
    const lx = text.toLowerCase(); let at = -1;
    for (const t of terms) { at = lx.indexOf(t); if (at >= 0) break; }
    const start = Math.max(0, at - 60); let s = (start ? '…' : '') + text.slice(start, start + 180) + (text.length > start + 180 ? '…' : '');
    s = esc(s);
    terms.forEach((t) => { if (t.length > 1) s = s.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'); });
    return s;
  }
  const searchEl = $('#search'); const searchInput = $('#search-input'); const searchResults = $('#search-results');
  let sel = 0; let results = [];
  function openSearch() { searchEl.hidden = false; searchInput.value = ''; searchResults.innerHTML = '<p class="search-empty">Type to search across every lesson, lab, card and cheatsheet.</p>'; searchInput.focus(); document.body.classList.add('no-scroll'); }
  function closeSearch() { searchEl.hidden = true; document.body.classList.remove('no-scroll'); }
  function drawResults() {
    const terms = searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    searchResults.innerHTML = results.length ? results.map((r, i) => `
      <a class="sr ${i === sel ? 'is-sel' : ''}" href="${r.href}" role="option" aria-selected="${i === sel}">
        <span class="sr-kind">${r.kind}</span><span class="sr-title">${esc(r.title)}</span><span class="sr-crumb">${esc(r.crumb)}</span>
        ${r.text ? `<span class="sr-snip">${snippet(r.text, terms)}</span>` : ''}</a>`).join('')
      : `<p class="search-empty">No matches for “${esc(searchInput.value)}”. Try fewer or shorter words.</p>`;
    $('.sr.is-sel', searchResults)?.scrollIntoView({ block: 'nearest' });
  }
  let searchTimer;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (!searchInput.value.trim()) { searchResults.innerHTML = ''; return; } results = search(searchInput.value); sel = 0; drawResults(); }, 80); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); drawResults(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); drawResults(); e.preventDefault(); }
    if (e.key === 'Enter' && results[sel]) { location.hash = results[sel].href; closeSearch(); }
  });
  searchEl.addEventListener('click', (e) => { if (e.target === searchEl) closeSearch(); if (e.target.closest('.sr')) closeSearch(); });

  // ---------------------------------------------------------------- after render: code, toc, anchors
  let spy = null;
  function afterRender(anchor) {
    if (window.Prism) $$('pre code[class*="language-"]', main).forEach((c) => { try { Prism.highlightElement(c); } catch (e) { /* unknown language */ } });
    if (spy) spy.disconnect();
    const toc = $('.toc', main);
    if (toc) {
      const links = new Map($$('a[data-anchor]', toc).map((a) => [a.dataset.anchor, a]));
      spy = new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) { links.forEach((a) => a.classList.remove('is-active')); links.get(en.target.id)?.classList.add('is-active'); } });
      }, { rootMargin: '0px 0px -75% 0px' });
      links.forEach((_, id) => { const h = document.getElementById(id); if (h) spy.observe(h); });
    }
    if (anchor) requestAnimationFrame(() => scrollToAnchor(anchor));
    else window.scrollTo(0, 0);
  }
  function scrollToAnchor(id) {
    const el = document.getElementById(id); if (!el) return;
    const d = el.closest('details'); if (d) d.open = true;
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (e) => {
    const copy = e.target.closest('.copy');
    if (copy) {
      const code = copy.closest('.code').querySelector('code').innerText;
      const done = () => { copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, () => fallbackCopy(code, done)); else fallbackCopy(code, done);
      return;
    }
    const anchorLink = e.target.closest('a[data-anchor]');
    if (anchorLink) { e.preventDefault(); scrollToAnchor(anchorLink.dataset.anchor); return; }
    const a = e.target.closest('[data-action]');
    if (!a) { if (e.target.closest('.sidebar a')) document.body.classList.remove('nav-open'); return; }
    const act = a.dataset.action;
    if (act === 'toggle-nav') { const open = document.body.classList.toggle('nav-open'); $('.menu-btn').setAttribute('aria-expanded', open); }
    else if (act === 'open-search') openSearch();
    else if (act === 'theme') { S.theme = { '': 'light', light: 'dark', dark: '' }[S.theme || '']; if (S.theme) document.documentElement.dataset.theme = S.theme; else delete document.documentElement.dataset.theme; save(); a.textContent = themeLabel(); }
    else if (act === 'toggle-read') {
      const id = a.dataset.mod; if (S.lessons[id]) delete S.lessons[id]; else S.lessons[id] = Date.now(); save(true);
      const m = mod(id); const y = window.scrollY; viewModule(m.track, m.slug, 'lesson'); window.scrollTo(0, y);
      if (S.lessons[id]) toast('Lesson marked as read. Its cards join your review.');
    }
    else if (act === 'toggle-lab') {
      const { mod: id, lab } = a.dataset; S.labs[id] = S.labs[id] || {};
      if (S.labs[id][lab]) delete S.labs[id][lab]; else S.labs[id][lab] = Date.now(); save(true);
      const m = mod(id); const y = window.scrollY; viewModule(m.track, m.slug, 'labs'); window.scrollTo(0, y);
      const p = progress(m); if (p.done) toast('Module complete.');
    }
    else if (act === 'flip') a.classList.toggle('is-flipped');
    else if (act.startsWith('quiz-')) quizAction(act, Number(a.dataset.oi));
    else if (act === 'reveal' || act === 'grade') reviewAction(act, a.dataset.g);
    else if (act === 'export') {
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `learning-hub-progress-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
      toast('Progress exported');
    }
    else if (act === 'reset') {
      if (a.dataset.confirm) { const theme = S.theme; S = blank(); S.theme = theme; save(true); toast('All progress reset'); viewProgress(); }
      else { a.dataset.confirm = '1'; a.textContent = 'Click again to erase everything'; setTimeout(() => { if (a.isConnected) { delete a.dataset.confirm; a.textContent = 'Reset all progress'; } }, 4000); }
    }
  });
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed. Select the text manually.'); } ta.remove();
  }

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') { if (!searchEl.hidden) closeSearch(); document.body.classList.remove('nav-open'); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); } return; }
    if (e.key === '/') { e.preventDefault(); openSearch(); return; }
    const quiz = $('#quiz');
    if (quiz && !$('.quiz-result', quiz)) {
      const k = e.key.toUpperCase();
      if (/^[A-H]$/.test(k)) { const b = $(`.opt[data-oi="${k.charCodeAt(0) - 65}"]`, quiz); if (b && !b.disabled) { quizAction('quiz-pick', k.charCodeAt(0) - 65); e.preventDefault(); } return; }
      if (e.key === 'Enter' && !document.activeElement?.closest('button,a')) { const b = $('.quiz-actions .btn.primary:not([disabled])', quiz); if (b) { b.click(); e.preventDefault(); } }
      return;
    }
    if ($('.review') && session?.queue.length) {
      if (e.key === ' ' && !session.flipped) { e.preventDefault(); reviewAction('reveal'); }
      else if (session.flipped && ['1', '2', '3', '4'].includes(e.key)) reviewAction('grade', ['again', 'hard', 'good', 'easy'][Number(e.key) - 1]);
    }
  });

  // ---------------------------------------------------------------- router
  function parseRoute() {
    let h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    let anchor = null;
    const at = h.indexOf('@'); if (at >= 0) { anchor = h.slice(at + 1); h = h.slice(0, at); }
    const p = h.split('/').filter(Boolean);
    if (!p.length) return { view: 'home' };
    if (p[0] === 'review') return { view: 'review', filter: p[1] || '' };
    if (p[0] === 'progress') return { view: 'progress' };
    if (p[0] === 't' && p[1]) return { view: 'track', track: p[1], page: p[2] === 'p' ? p[3] : null, anchor };
    if (p[0] === 'm' && p[2]) return { view: 'module', track: p[1], slug: p[2], tab: p[3] || 'lesson', anchor };
    return { view: 'notfound' };
  }
  let lastRouteKey = '';
  function route() {
    const r = parseRoute();
    const key = `${r.view}|${r.track || ''}|${r.slug || ''}|${r.tab || ''}|${r.page || ''}|${r.filter || ''}`;
    // Same page, only the anchor changed: just scroll.
    if (key === lastRouteKey && r.anchor) { scrollToAnchor(r.anchor); return; }
    lastRouteKey = key;
    document.body.classList.remove('nav-open');
    if (r.view === 'home') { viewHome(); window.scrollTo(0, 0); }
    else if (r.view === 'review') { viewReview(r.filter); window.scrollTo(0, 0); }
    else if (r.view === 'progress') { viewProgress(); window.scrollTo(0, 0); }
    else if (r.view === 'track') { viewTrack(r.track, r.page); if (r.anchor) requestAnimationFrame(() => scrollToAnchor(r.anchor)); }
    else if (r.view === 'module') viewModule(r.track, r.slug, r.tab, r.anchor);
    else viewNotFound();
    const t = r.track && track(r.track); const m = r.slug && mod(`${r.track}/${r.slug}`);
    document.title = [m?.title, t?.title, DATA.catalog.title].filter(Boolean).join(' · ');
    if (r.view !== 'home') main.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  route();
})();
