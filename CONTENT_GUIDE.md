# Content Guide — how to add and write learning material

Everything you learn in this hub lives in `content/`. The app never needs code changes to add
a new topic: you add folders and files, run the build, and refresh the page.

```text
content/
  catalog.json                 # groups of tracks shown on the home page (order matters)
  tracks/
    <track-id>/                # e.g. docker, kubernetes, terraform, system-design ...
      track.json               # track metadata
      cheatsheet.md            # optional extra pages, declared in track.json "pages"
      interview.md
      <NN-module-slug>/        # e.g. 01-containers-101  (NN = order, two digits)
        module.json            # metadata, objectives, resources  (required)
        lesson.md              # theory + guided examples          (required)
        labs.md                # hands-on exercises                (optional but recommended)
        quiz.json              # self-check questions              (optional)
        flashcards.json        # spaced-repetition cards           (optional)
```

After any change run:

```bash
node build/build.mjs          # validates and bundles everything into dist/content.js
node build/build.mjs --watch  # rebuilds automatically while you write
```

Then refresh `index.html` in the browser (works straight from the file system — no server needed).

---

## 1. Add a new topic (track)

1. Create `content/tracks/<track-id>/track.json`:

```json
{
  "title": "System Design",
  "tagline": "One sentence on what you will be able to do.",
  "description": "A short paragraph shown on the track page.",
  "accent": "#0F766E",
  "level": "Intermediate",
  "prerequisites": [],
  "pages": [
    { "id": "cheatsheet", "title": "Cheatsheet", "file": "cheatsheet.md" }
  ]
}
```

2. Add the track id to a group in `content/catalog.json` (or create a new group).
3. Add module folders `01-...`, `02-...`. Module order = folder-name order.

## 2. module.json

```json
{
  "title": "Images & Dockerfiles",
  "summary": "One or two sentences shown in lists.",
  "level": "beginner",                 
  "estimatedMinutes": 120,
  "objectives": [
    "Explain how image layers and the build cache work",
    "Write a Dockerfile for a Node.js service"
  ],
  "resources": [
    { "title": "Dockerfile reference", "url": "https://docs.docker.com/reference/dockerfile/", "type": "docs", "note": "The canonical list of instructions." }
  ]
}
```

`level` is one of `beginner`, `intermediate`, `advanced`.
Resource `type` is one of `docs`, `article`, `video`, `book`, `tool`, `course`, `spec`.
Prefer **official, original sources** (docs.docker.com, kubernetes.io, developer.hashicorp.com,
GitHub repos of the projects, CNCF, AWS docs). Only link URLs you are confident exist.

## 3. lesson.md and labs.md — Markdown plus a few extensions

Standard Markdown (GitHub flavour): headings, lists, tables, links, **bold**, `inline code`,
fenced code blocks with a language (`bash`, `dockerfile`, `yaml`, `hcl`, `json`, `typescript`,
`javascript`, `text`, `ini`, `go`, `python`, `diff`).

- `## Heading` sections become the lesson's table of contents. Do **not** use a `#` (H1) heading —
  the module title is shown automatically. Use `###` for sub-sections.
- Use ```` ```text ```` blocks for ASCII diagrams.

### Callout blocks

A block starts with `:::type Optional title` on its own line and ends with `:::` on its own line.
Blocks cannot be nested inside each other (code fences inside them are fine).

| Block | Use it for |
| --- | --- |
| `:::tip` | Practical advice, shortcuts |
| `:::info` | Background, context |
| `:::warning` | Pitfalls, things that cost money or break production |
| `:::mac` | macOS / Apple Silicon specific notes |
| `:::deep Title` | Collapsible deep-dive for the curious (closed by default) |
| `:::try Title` | A 1–3 minute "try it now" mini-exercise inside a lesson |
| `:::hint` | (labs) Collapsible hint |
| `:::solution` | (labs) Collapsible full solution |
| `:::details Title` | Generic collapsible |

### labs.md structure

- Any text before the first `##` is the labs introduction (prerequisites, setup, cleanup).
- **Every `## Heading` is one lab** and gets its own "done" checkbox in the app (progress is keyed
  by the heading text, so avoid renaming finished labs).
- Optionally right under the heading add a meta block:

```text
:::meta
difficulty: easy | medium | hard
time: 20 min
:::
```

- Recommended inside a lab: a goal sentence, `### Steps`, `### Verify` (how to know it worked),
  `:::hint` and `:::solution` blocks, and `### Clean up`.

## 4. quiz.json

```json
[
  {
    "type": "single",
    "q": "Which instruction sets the default command but is easily overridden by `docker run` arguments?",
    "options": ["`ENTRYPOINT`", "`CMD`", "`RUN`", "`SHELL`"],
    "answer": 1,
    "explain": "`CMD` provides defaults; arguments after the image name replace it. `ENTRYPOINT` is only replaced with `--entrypoint`."
  },
  {
    "type": "multi",
    "q": "Which of these invalidate the build cache for later layers? (select all)",
    "options": ["Changing a copied file", "Changing a LABEL at the end", "Changing an earlier RUN line", "Adding a comment"],
    "answer": [0, 2],
    "explain": "..."
  }
]
```

`answer` is a zero-based index (`single`) or an array of indexes (`multi`). Inline Markdown
(`code`, **bold**) is allowed in `q`, `options` and `explain`. Always explain *why*.

## 5. flashcards.json

```json
[
  { "front": "What is the difference between a volume and a bind mount?", "back": "A volume is managed by Docker ... a bind mount maps a host path ..." }
]
```

Cards from every module are reviewed with a simple spaced-repetition (Leitner) schedule in the
**Review** screen. Keep fronts short and backs to 1–4 sentences. Inline Markdown is allowed.
