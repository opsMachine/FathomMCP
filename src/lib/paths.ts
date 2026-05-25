import { join } from "node:path";

/**
 * Single source of truth for every filesystem path the FathomMCP code reads
 * or writes. Rooted at `FATHOM_DATA_ROOT` if set, otherwise at the repo root
 * so a fresh `git clone` of just FathomMCP keeps working with no env setup.
 *
 * Layout under the data root:
 *
 *   <FATHOM_DATA_ROOT>/
 *     data/
 *       raw/             — JSON-per-meeting from extract
 *       vectors/         — LanceDB
 *       index.db         — SQLite
 *       sync-state.json  — extract cursor / dedupe set
 *       proposals.yml    — staging for label decisions
 *       candidates/      — generated dossier markdown
 *       logs/            — nightly-sync output
 *       .sync.lock       — flock guard
 *     vault/
 *       Meetings/        — full transcripts (gitignored)
 *       People/          — opaque references (tracked)
 *       Companies/       — opaque references (tracked)
 *     config/
 *       labels.yml       — taxonomy source of truth
 *
 * The shell script `scripts/nightly-sync.sh` mirrors the same env-var
 * convention for its lock file and log directory.
 */

const DEFAULT_ROOT = join(import.meta.dirname, "..", "..");

const envRoot = process.env.FATHOM_DATA_ROOT?.trim();

export const DATA_ROOT = envRoot && envRoot.length > 0 ? envRoot : DEFAULT_ROOT;

export const DATA_DIR = join(DATA_ROOT, "data");
export const RAW_DIR = join(DATA_DIR, "raw");
export const VECTORS_DIR = join(DATA_DIR, "vectors");
export const INDEX_DB_PATH = join(DATA_DIR, "index.db");
export const SYNC_STATE_PATH = join(DATA_DIR, "sync-state.json");
export const PROPOSALS_PATH = join(DATA_DIR, "proposals.yml");
export const LOGS_DIR = join(DATA_DIR, "logs");
export const CANDIDATES_DIR = join(DATA_DIR, "candidates");
export const LOCK_FILE_PATH = join(DATA_DIR, ".sync.lock");

export const VAULT_DIR = join(DATA_ROOT, "vault");
export const MEETINGS_DIR = join(VAULT_DIR, "Meetings");
export const PEOPLE_DIR = join(VAULT_DIR, "People");
export const COMPANIES_DIR = join(VAULT_DIR, "Companies");

export const CONFIG_DIR = join(DATA_ROOT, "config");
export const LABELS_PATH = join(CONFIG_DIR, "labels.yml");
