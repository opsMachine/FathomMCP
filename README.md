# FathomMCP

Local-first semantic search over Fathom meeting recordings, exposed to AI clients (Cursor, Claude Desktop, Claude Code) via MCP.

**This repo is tool code only.** Your corpus (`data/`, `vault/`, `config/labels.yml`) lives in a separate directory pointed to by `FATHOM_DATA_ROOT` — typically a private meta-workspace folder such as `your-workspace/fathom-vault/`. See [Where data lives](#where-data-lives).

> Generalized, recorder-agnostic fork: [`opsMachine/seed-workspace`](https://github.com/opsMachine/seed-workspace) (`infra/transcript-vault-mcp/`). This repo remains the Fathom-specific implementation.

---

## What it does

Capabilities the Fathom UI does not provide:

- Semantic search across your full meeting history
- Chronological relationship timelines per person, company, or topic
- Dual-retrieval claim verification (supporting *and* contradicting evidence)
- Pre-meeting briefings, client personas, and sales coaching via MCP workflow prompts

**Stack:** TypeScript · SQLite + FTS5 · LanceDB · `@xenova/transformers` (local embeddings, no OpenAI) · MCP stdio server.

---

## Quick start

```bash
git clone https://github.com/opsMachine/FathomMCP.git
cd FathomMCP
npm install

# Create a corpus directory (NOT inside this repo if you plan to publish your workspace)
mkdir -p ~/Documents/GitHub/my-workspace/fathom-vault/config
cp config/labels.yml.template ~/Documents/GitHub/my-workspace/fathom-vault/config/labels.yml

cp .env.example .env
# Edit .env:
#   FATHOM_API_KEY=...        # https://app.fathom.video/settings/integrations
#   FATHOM_DATA_ROOT=/abs/path/to/my-workspace/fathom-vault

npm run extract
npm run transform
npm run embed
npm run mcp   # smoke-test MCP server (Ctrl+C to exit)
```

Register in your IDE's `.cursor/mcp.json` (see `.cursor/mcp.json` if present, or copy from your meta-workspace template) with the same `FATHOM_DATA_ROOT`.

---

## Where data lives

The pipeline reads and writes under **`$FATHOM_DATA_ROOT`**, not this repo. Layout:

```
$FATHOM_DATA_ROOT/          (e.g. my-workspace/fathom-vault/)
├── config/
│   └── labels.yml         ← TRACK in your private meta-workspace (taxonomy source of truth)
├── data/                  ← gitignore (heavy / sensitive)
│   ├── raw/               JSON per meeting from extract
│   ├── vectors/           LanceDB
│   ├── index.db           SQLite + FTS5
│   ├── sync-state.json
│   ├── proposals.yml      staging for label decisions
│   ├── candidates/        generated dossiers
│   └── logs/
└── vault/
    ├── Meetings/          gitignore — full transcripts
    ├── People/            optional track — opaque [Meeting #N] links only
    └── Companies/         optional track — same shape
```

**Recommended pattern:** keep `FATHOM_DATA_ROOT` in your **private meta-workspace** repo (strategy docs, client folders, and `fathom-vault/` version together). Clone this repo as a sibling (`fathom-mcp/` symlink is fine). Never commit real `labels.yml`, People/Companies files, or transcripts into **this** public tool repo.

Copy `config/labels.yml.template` → `$FATHOM_DATA_ROOT/config/labels.yml` before your first `prep:people` run.

---

## Pipeline

```
Fathom REST API
  → data/raw/*.json         (npm run extract)
  → vault/**/*.md           (npm run transform)
  → data/index.db           (npm run transform)
  → data/vectors/*          (npm run embed)
  → MCP server              (npm run mcp)
```

**Labeling loop:** `prep:people` / `prep:companies` → edit `data/proposals.yml` in chat → `apply-labels` → re-transform. See [`ROADMAP.md`](ROADMAP.md) for sprint history and MCP tool details.

**Nightly sync:** `scripts/nightly-sync.sh` + `scripts/fathom-sync.service` (systemd user unit). Set `Environment=FATHOM_DATA_ROOT=...` in the service file.

---

## MCP tools

| Tool | Purpose |
|---|---|
| `list_meetings` | Filter by person, company, date, relationship, call type |
| `semantic_search` | Vector search across transcript chunks |
| `keyword_search` | FTS5 over titles and summaries |
| `get_entity_timeline` | Chronological mentions of a person/company/topic |
| `get_project_status` | Latest inferred state of a project or deal |
| `verify_claim` | Supporting + contradicting evidence for a stated claim |
| `get_transcript` | Full indexed chunks for one recording |

**Prompts:** `client_persona`, `sales_coaching`, `content_from_meetings`, `account_prep`.

Research discipline: [`skills/fathom-research/SKILL.md`](skills/fathom-research/SKILL.md) (also served as MCP resource `skill://fathom-research`).

---

## License

MIT — see [LICENSE](LICENSE).
