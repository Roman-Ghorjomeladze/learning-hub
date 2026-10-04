# Learning Hub

A personal, hands-on learning hub. It currently holds three DevOps tracks (Docker, Kubernetes,
Terraform) plus integrated portfolio projects:

| Track | Modules | What you get |
| --- | --- | --- |
| Docker | 11 | Mac setup, internals, images, production builds, storage, networking, Compose, security, debugging, capstone |
| Kubernetes | 15 | Architecture to production: workloads, Gateway API, config, storage, scheduling, autoscaling, RBAC, Helm/GitOps, observability, capstone |
| Terraform | 9 | HCL, state, modules, AWS, Kubernetes, testing & CI, capstone |
| Integrated projects | 3 | Laptop-to-cluster platform, CI/CD pipeline, incident drills |

Each module has a **lesson**, **hands-on labs** (with hints and full solutions), a **quiz**,
**flashcards** for spaced repetition, links to **original sources**, and a **notes** tab.
Each track also has a cheatsheet and interview questions.

## Use it

Double-click `index.html` (or `open index.html`). No server, no install, works offline.

- Start with **Docker → 00 Set Up Your Mac**. It installs every tool used later.
- Work each module in order: Lesson → Labs → Quiz (70% to pass) → Review cards daily.
- Press `/` (or `Cmd+K`) to search everything.
- Progress, quiz scores, card schedule and notes live in your browser's local storage.
  Use **Progress & backup → Export** from time to time.

## Add new topics

Content lives in `content/` as Markdown and JSON. To add a topic (say, System Design):

1. Create `content/tracks/system-design/track.json` and module folders `01-...`, `02-...`.
2. Add `"system-design"` to a group in `content/catalog.json` (or add a new group).
3. Run `npm run build` (or `node build/build.mjs`; `npm run watch` rebuilds as you type).
4. Refresh the page.

The full format (module files, callout blocks, labs, quiz and flashcard JSON) is in
[`CONTENT_GUIDE.md`](CONTENT_GUIDE.md). The build validates everything and tells you exactly
which file and line is wrong.

## Project layout

```text
index.html            entry point
app/                  UI (app.js, styles.css, bundled fonts, Prism for code highlighting)
build/build.mjs       content builder (zero dependencies; marked is vendored)
content/              all learning material (edit here)
dist/content.js       generated bundle loaded by the page (do not edit)
```

Requires Node.js 18+ only for rebuilding content.
