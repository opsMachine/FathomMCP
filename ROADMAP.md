# Fathom Knowledge Base -- Roadmap

*Last updated: 2026-04-23 16:30 (America/Toronto)*

A local-first knowledge base built from Fathom meeting recordings. Data lives
on disk in a markdown vault + SQLite + LanceDB, and is exposed to AI clients
(Cursor, Claude Desktop) through a local MCP server.

## Repository layout (post-2026-04-23 restructure)

This repo is now **pure tool code**. The corpus (raw JSON, SQLite, vectors,
markdown vault, taxonomy YAML) lives at `$FATHOM_DATA_ROOT`, defaulting to
`OM-Repo/fathom-vault/` so the data and the strategy artifacts that
reference it version together.

- `src/lib/paths.ts` -- single source of truth. Every other module imports
  `RAW_DIR`, `INDEX_DB_PATH`, `VECTORS_DIR`, `LABELS_PATH`, etc. from here.
- `scripts/nightly-sync.sh` and `scripts/fathom-sync.service` honor the same
  env var (the systemd unit sets `Environment=FATHOM_DATA_ROOT=%h/Documents/...`).
- If `FATHOM_DATA_ROOT` is unset, paths fall back to the FathomMCP repo root
  so a fresh `git clone` of just this repo still works (sub-dirs are
  auto-created on first use).

The corpus's own README is at
[`../OM-Repo/fathom-vault/README.md`](../OM-Repo/fathom-vault/README.md)
and documents what's tracked vs gitignored, the labeling workflow, and the
MCP prompts. Out-of-date claims below about `vault/People/*.md` or
`config/labels.yml` being "tracked" should be read as *tracked in the data
root* (now in OM-Repo), not in this repo.

## Pipeline at a glance

```
Fathom REST API
   -> data/raw/*.json         (npm run extract)
   -> vault/**/*.md           (npm run transform, human-browseable)
   -> data/index.db           (npm run transform, SQLite + FTS5 + label projections)
   -> data/vectors/*          (npm run embed, LanceDB @ 384-dim)
   -> MCP server              (npm run mcp, stdio)
   -> Cursor / Claude Desktop

Labeling loop (human-in-the-loop, git-tracked source of truth):
   config/labels.yml          (TRACKED single source of truth)
      ^
      |  npm run apply-labels  (atomic merge + diff + re-transform)
      |
   data/proposals.yml          (gitignored, Cursor-written)
      ^
      |  Cursor chat reads the dossier, writes decisions
      |
   data/candidates/*.md        (gitignored, npm run prep:people / prep:calls)
```

---

## Sprints

### Sprint 1 -- Extract -- DONE

- Paginated Fathom REST client with rate limiting.
- Resumable sync state (`data/sync-state.json`).
- **1,173 meetings** pulled into `data/raw/*.json` (transcripts + summaries).

### Sprint 2 -- Transform -- DONE

- JSON -> markdown with YAML frontmatter.
- Per-meeting, per-person, per-company markdown files in `vault/`.
- Generic-domain filter (gmail, yahoo, etc. excluded from company index).

### Sprint 3 -- Index + Query -- DONE

- SQLite index with meetings, participants, meeting_participants, companies,
  meeting_companies, plus FTS5 over titles and summaries.
- Local embedding pipeline using `Xenova/all-MiniLM-L6-v2` (384-dim,
  quantized, offline after first run).
- **29,926 chunks** stored in LanceDB (`data/vectors/`, ~42MB).
- Resumable embedding (`npm run embed` skips already-embedded recordings,
  `--fresh` rebuilds).
- `src/dedupe-vectors.ts` utility to clean accidental duplicates.
- `npm run query` CLI with subcommands: `list`, `get`, `person`, `company`,
  `keyword`, `search`, `context`.
- Structured filters (person/company/date/type) compose with semantic search.

### Sprint 4 -- MCP Server -- DONE

- `src/mcp-server.ts` -- stdio MCP server on top of the local stores.
- Tools exposed:
  - `list_meetings`, `get_meeting`
  - `find_person`, `find_company`
  - `keyword_search` (FTS5), `semantic_search` (vector)
  - `build_context` (ready-to-paste markdown block)
- Registered in:
  - `OM-Repo/.cursor/mcp.json` (project-level, auto-loads when OM is the
    workspace; passes `FATHOM_DATA_ROOT` so the server resolves the in-tree corpus)
  - `~/.config/Claude/claude_desktop_config.json` (global; same env block)
- Smoke test at `src/mcp-smoketest.ts` exercises every tool through a real
  MCP client connection.

### Sprint 5 -- Prompt Templates -- DONE

Four MCP prompts registered on the server that orchestrate the tools into
complete workflows. Each prompt expands into a detailed instruction message
telling the LLM which tools to call, in what order, and what structured
output to produce. Every prompt also includes the speaker-attribution
caveat.

- `client_persona` -- args: `company`, optional `focus`. Enumerates every
  meeting with a company, scoped semantic searches across persona
  dimensions, produces pains / goals / objections / decision style /
  priorities with citations.
- `sales_coaching` -- args: `recording_id`, optional `angle`. Pulls the
  full meeting + scoped transcript searches for objections and
  commitments, produces a timestamped coaching review.
- `content_from_meetings` -- args: `topic`, optional `audience`, `format`.
  Keyword + semantic sweep, produces themes, anecdotes, pull-quotes, and
  (optionally) a draft post in the requested format.
- `account_prep` -- args: `company` or `person`, optional `lookback_days`.
  Pre-meeting briefing: relationship state, open actions, unresolved
  concerns, recommended agenda, landmines.

Smoke test (`src/mcp-smoketest.ts`) covers all 7 tools and all 4 prompts:
13/13 passing.

### Sprint 6 -- Taxonomy Labels -- DONE

A relationship + call-type taxonomy layered on top of the knowledge base so
prompts and MCP queries can scope by `client`, `prospective_partner`, `sales`,
`advisory`, etc.

**Design**: single git-tracked source of truth at `config/labels.yml`,
projected into SQLite and injected into vault markdown on every transform.
All labeling is human-in-the-loop: a prep script generates a self-contained
markdown dossier of unlabeled candidates, the reviewer reads it in Cursor
chat, Cursor writes `data/proposals.yml`, `npm run apply-labels` merges
into the source-of-truth file (atomic write + printed diff).

**Tags**

- Relationships (per person, email-keyed): `advisor_to`, `advisor`,
  `prospective_advisor`, `client`, `former_client`, `prospective_client`,
  `partner`, `prospective_partner`, `candidate`, `vendor`, `team`,
  `colleague`, `friend`, `family`, `connection`. (`investor` and `portfolio`
  were dropped in Sprint 7 as unused.)
- Call-types (per meeting, recording_id-keyed): `sales`, `qualification`,
  `prospecting`, `demo`, `onboarding`, `check_in`, `advisory` (auto), `pitch`,
  `interview`, `planning`, `strategy`, `networking`, `internal` (auto),
  `meetings`, `social`.
- Auto-derived tags (`internal`, `advisory`) are computed at transform time
  and projected into SQLite; they never appear in `config/labels.yml`.

**Workflow**

1. `npm run prep:people` -- emits `data/candidates/people-dossier.md`
   (first 30 unlabeled candidates by default; `--all` to emit everything;
   `--limit N` to tune). Idempotent: skips anyone already in `labels.yml`
   or already staged in `proposals.yml`.
2. In Cursor chat, read the dossier and write tag decisions into
   `data/proposals.yml` using the shape shown in the dossier instructions.
3. `npm run apply-labels --dry-run` to preview the diff.
4. `npm run apply-labels` to merge atomically and re-run transform.
   Use `--clear` to truncate `proposals.yml` on success.
5. Same loop for meetings via `npm run prep:calls`.

**Dossier-in-passes**: the ~320 people and ~1,173 meetings won't fit in a
single chat turn. Default `--limit 30` keeps each pass small. Label a batch,
apply, re-run prep -- the idempotent skip logic keeps you moving forward.

**MCP surface (phase 2, also DONE)**

- `list_meetings` gained optional `relationships: string[]` and
  `call_types: string[]` filters. OR within an array, AND across.
- `semantic_search` gained the same filters; applied as a scope before
  vector search.
- `list_people_by_relationship` new tool: returns people carrying a given
  tag, optionally with recent meetings.
- `company_relationships` filter on `list_meetings`, `semantic_search`,
  `build_context`; `list_companies_by_relationship` for org-shaped queries.

**Storage split**

- `config/labels.yml` -- **TRACKED**. Single source of truth. Hand-editable.
  Transform reads, never writes; atomic merge only via `apply-labels`.
  Optional root `skipped:` lists emails / domains excluded from prep
  dossiers only (not projected to SQLite).
- `data/proposals.yml` -- gitignored. Staging area for chat-proposed labels.
- `data/candidates/*.md` -- gitignored. Regeneratable dossiers with meeting
  summary excerpts.
- `vault/People/*.md` and `vault/Companies/*.md` -- **TRACKED**. Now render
  Meeting History as `[Meeting #12345](../Meetings/12345.md)` (opaque
  recording_id links) so meeting titles and dates no longer leak to git.
- `vault/Meetings/*.md` -- gitignored. File names switched to
  `<recording_id>.md`; titles live inside the front-matter + h1.
- `data/index.db` -- gitignored. New `person_labels` and `meeting_labels`
  tables, pure projections of `labels.yml` plus auto-derived meeting tags.

**Validation**

`apply-labels` warns + skips (never fails) on:
- unknown relationship / call-type tags
- empty proposals (no tags, no notes)
- person emails not present in `participants` (typo hint) -- written anyway
  so labels survive stale SQLite
- `recording_id`s not present in `meetings` -- same

---

### Sprint 7 -- Labeling Accuracy -- **COMPLETE** (2026-04-17)

**Phase A shipped (2026-04-16):** company-label vocabulary, schema, loader,
merger, transform projection, `prep:companies` dossier generator. 171
unlabeled companies surface through `npm run prep:companies`.

**Phase B shipped (2026-04-16):** dossier v2 with `src/lib/triage.ts` --
signal extraction (recency, cadence, keywords, title patterns, domain
shape, role-inbox detection, org-tag inheritance). Both `prep:companies`
and `prep:people` now triage candidates into A_PROPOSE / A_SKIP / B / C
buckets, surface only the ambiguous (B) cases for human review, and
pre-fill suggested tags inline. Added `former_vendor_org` to the company
vocabulary based on the alistova.com adjudication. Vault projection now
distinguishes `company_relationships` (org-direct) from
`person_relationships` (aggregated from individuals).

Validated end-to-end with a real MCP-style query (advisory action items
in last 14d) -- the path SQL -> triage -> labels -> filtered query
returns useful results in &lt;1s. Confirmed labels are load-bearing: the
query is meaningless without `advisor_to` person tags.

**Phase C shipped (2026-04-16):** MCP surface complete. Per-person
`relationships` and per-meeting `call_types` filters were added in
Sprint 6; this batch added per-org `company_relationships` to
`list_meetings`, `semantic_search`, and `build_context`, and
introduced `list_companies_by_relationship` as the org-shaped mirror
of `list_people_by_relationship`. `list_meetings` output now also
enriches each row with its `companies` and call-type `tags` so the
caller can see what filters matched without a second round-trip.
Vocabulary additions for symmetry: person-level `former_partner` and
`former_prospective_partner` (mirror of the corresponding `_org`
tags). Tightened the `candidate` triage rule to require a title-level
"Interview ..." hit instead of a summary keyword.

**Final totals:** 64 people labeled (81 tags), 30 companies labeled
(36 org tags). Person-vocab 17 tags; company-vocab 14 tags.

**Close-out:** Optional `skipped:` block in `labels.yml` (hand-edited;
preserved by `apply-labels`) excludes reviewed no-value emails/domains
from `prep:people` / `prep:companies` so they stop resurfacing. Initial
entries: `que10545@adobe.com`, `mail.concordia.ca`. `otec.org` labeled
`former_client_org` (was a Pragmaflow client).

Batch-3 correction rate was effectively zero vs. dossier drafts — the
&lt;10% goal is met. Ongoing labeling is operational work, not a sprint
blocker.

---

### Sprint 8 -- (next)

Pick one or combine lightly:

1. **Continue taxonomy coverage** -- people/companies batches with
   `prep:* --limit 50`; skip-list grows as edge cases appear.
2. **Embeddings / RAG** -- finish or resume `npm run embed` with progress
   UX; validate semantic search quality on labeled subsets.
3. **Light metrics** -- optional script to diff `proposals.yml` vs.
   merged `labels.yml` tag counts per batch (correction-rate telemetry).

---

Sprint 6 shipped a working taxonomy pipeline but batch-1 labeling had a
~40% correction rate. Root cause: the dossier surfaced only meeting
summaries, ignoring three decisive signals already present in SQLite --
organization context, co-attendee graph structure, and relationship
recency. Sprint 7 closes that gap.

**Goal:** <10% correction rate by batch 3 of people dossiers, measured
by comparing proposed vs. final tags at `apply-labels` time.

**1. Company-level relationship labels**

New vocabulary (per-domain, keyed in `config/labels.yml` under `companies:`):

`self`, `client_org`, `former_client_org`, `prospective_client_org`,
`partner_org`, `prospective_partner_org`, `advisor_to_org`, `advisor_org`,
`prospective_advisor_org`, `vendor_org`.

Orgs may carry multiple tags (e.g. Alistova = `partner_org + vendor_org`).
No `family_org` / `friend_org` / `team_org` -- those stay person-level.

**Semantics: override.** Org labels act as a **prior / suggestion** when
generating person-label proposals. They are never automatically projected
as person tags. A person's explicit relationship always wins (Avi ends up
`vendor` even though Alistova is `partner_org`; Josh ends up `team` even
though Alistova is also `vendor_org`).

**2. Graph-enriched dossier v2**

Per candidate, the dossier now surfaces:

- **Company block** -- domain, existing company tags, and the default
  suggestion those tags imply for a person (e.g. "Alistova [partner_org,
  vendor_org] -- default suggests: team | vendor").
- **Co-attendee block** -- top 5 co-attendees with known labels plus
  meeting count (e.g. "Josh Cohen [team] -- 23 meetings together").
- **Recency block** -- last 3 meetings (recording_id, date, call_types).
- **Signal-based suggestion** -- one-line proposed tag(s) plus reasoning.

Dossier output splits into three sections by confidence: **confident**,
**needs_confirmation**, **adjudicate**. No tier auto-applies; the split
exists purely to triage review effort.

**3. Cheap cleanup bundled in**

- Label `mitch@opsmachine.co` as `self` at person-level and
  `opsmachine.co` as `self` at company-level so the reviewer's own emails
  stop appearing in dossiers.
- Drop unused `investor` / `portfolio` person tags (not applied to any
  current label).

**4. New schema + script**

- `company_labels` table (domain, tag, notes) with FK to `companies`.
- `config/labels.yml` gains `companies: {}` block; loader + merger + dry-run
  diff updated.
- `src/prep-companies.ts` -> `data/candidates/companies-dossier.md`.
- Run order: **companies first**, then people (person dossier uses company
  tags as prior).
- Transform projects `company_labels` into `vault/Companies/*.md`
  front-matter + `companies.relationships` SQLite column.

**5. MCP surface (thin slice)**

- `list_meetings` / `semantic_search` -- add optional
  `company_relationships: string[]` filter.
- `list_companies_by_relationship` -- new tool, mirrors
  `list_people_by_relationship`.

**6. No auto-apply.** Everything still routes through `proposals.yml`.
Confidence is metadata for triage only. Revisit after batch 3 accuracy
data exists.

**Effort:** ~6-8h. Additive -- no migration of Sprint 6 labels needed.

**Non-goals for Sprint 7:** correction-memory / few-shot learning from
past edits (defer to a later sprint once we have baseline accuracy data).

---

## Backlog -- Future Work

Things worth doing but not urgent enough to block current sprints. Each item
needs its own design pass before implementation.

### Speaker attribution recovery

**Problem.** Fathom often returns transcript entries with
`speaker: { name: null, email: null }`, which surfaces in search results as
`Unknown:` prefixes. This degrades persona work, coaching analysis, and any
"who said what" query.

**Why defer.** Doing this well is non-trivial and benefits from a dedicated
investigation:

- Audit scope: how many chunks are affected, by meeting type, by date.
- Signal sources:
  - `calendar_invitees` list (known participants).
  - Speaker turns and conversational structure.
  - Self-references ("this is Mitch", "Jalyn, what do you think?").
  - Per-meeting organizer / `recorded_by` metadata.
  - Possibly voice-print / diarization from the underlying audio (if the
    Fathom API ever exposes it).
- Evaluation: we need a hand-labeled set of calls to measure attribution
  accuracy before we trust it.
- Persistence: attributed speakers should live alongside raw transcripts
  (not replace them) so we can re-run attribution as methods improve.

**Placeholder workarounds** until this lands:

- When quoting transcript snippets in personas/coaching output, include the
  full participant list and flag `Unknown` speakers explicitly.
- Prefer meeting summaries (Fathom's own attribution is more reliable) over
  raw transcript for persona-level claims about "who said X".

### Incremental / scheduled sync -- DONE (2026-04-23)

Nightly automation lands new meetings on disk, into the SQLite index, and
into LanceDB without manual intervention. Tagging stays human-in-the-loop;
new meetings just surface unlabeled in the next `prep:*` dossier pass.

- `scripts/nightly-sync.sh` -- wrapper that runs extract -> transform ->
  embed in sequence. Sources nvm so node/tsx are on PATH under systemd,
  uses `flock` so manual + timer-driven runs can't collide, tees output
  to `data/logs/sync-YYYY-MM-DD.log` (and prunes logs older than 30d).
- `scripts/fathom-sync.service` + `scripts/fathom-sync.timer` -- systemd
  user units, symlinked into `~/.config/systemd/user/`. `OnCalendar=*-*-*
  03:00:00` with `Persistent=true` so a missed run (laptop asleep) fires
  at next wake. Inspect with `systemctl --user list-timers fathom-sync.timer`
  and `journalctl --user -u fathom-sync -n 200`.
- `npm run sync:nightly` -- same wrapper, for one-off manual runs.

Embed delta path is built-in to `embed.ts`: it queries existing chunk IDs
from LanceDB and only embeds the new ones, so the nightly run is cheap
(~7s wall clock when nothing new arrived).

### Action-item + decision extraction

- Fathom summaries contain action items (`[ ]` and `[x]`). Parse them into
  a structured `action_items` SQLite table with assignee + state so the MCP
  can answer "what did I commit to that's still open?".

### Better chunking for long meetings

- Current chunking is word-count based. For 60+ minute calls, consider
  segmenting on topic shifts (detected by cosine distance jumps between
  adjacent sentences) so chunks are topically coherent.

### Re-ranking layer

- After vector recall, add a cross-encoder reranker (still local) for the
  top-N hits to improve precision on conceptual queries.

### Multi-user / team vault

- Everything is single-user right now. For a team rollout we'd need:
  - Per-recording visibility (recorded_by or team membership).
  - Separate API keys / sync state per user.
  - Shared companies + people, private transcripts.

---

## How to use the MCP prompts

In Cursor: type `/` in the chat to see available slash commands, or mention
`@fathom-kb` and ask for a persona / coaching / prep briefing. Claude
Desktop exposes prompts from the `+` (attachment) menu under "MCP".

Example invocations:

- `client_persona(company="alistova.com", focus="pricing sensitivity")`
- `sales_coaching(recording_id="138356277", angle="discovery quality")`
- `content_from_meetings(topic="AI adoption", audience="consultants", format="LinkedIn post")`
- `account_prep(company="alistova.com", lookback_days="60")`

Every prompt returns a single user message containing:
1. The structured task.
2. An ordered list of tool calls the LLM should make.
3. A required output template with citation rules.
4. The speaker-attribution caveat.

## Conventions

- All timestamps stored ISO-8601 UTC.
- Filenames sanitized to `[<safe chars>]{1,100}`.
- Email addresses lowercased when used as keys.
- Generic email domains (gmail, yahoo, hotmail, outlook, icloud, aol,
  protonmail, mail.com) are excluded from the company index.
