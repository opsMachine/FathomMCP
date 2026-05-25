#!/usr/bin/env tsx
/**
 * apply-labels
 *
 * Merge `data/proposals.yml` into the source-of-truth `config/labels.yml`,
 * atomically. Prints a unified diff before writing; supports --dry-run.
 *
 * Merge semantics:
 *   - People: tags are set-unioned (no duplicates, no deletions).
 *   - Meetings: same.
 *   - `notes`: last-write-wins (proposals overwrite) when non-empty, else
 *     preserved from the existing file.
 *
 * Validation is warn-and-skip, never fail:
 *   - Unknown tags are skipped with a warning.
 *   - Emails not in participants are warned but still written (so we don't
 *     lose typed-in labels if SQLite is out of date). Rerun transform to
 *     re-project.
 *   - recording_ids not in meetings are warned but still written.
 *   - Empty / malformed entries are skipped.
 */

import { Command } from "commander";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "yaml";
import { openDb, initSchema } from "./lib/db.js";
import {
  RELATIONSHIP_TAGS,
  CALL_TYPE_TAGS,
  COMPANY_RELATIONSHIP_TAGS,
  isRelationshipTag,
  isCallTypeTag,
  isCompanyRelationshipTag,
} from "./lib/labels.js";
import { LABELS_PATH, PROPOSALS_PATH } from "./lib/paths.js";

interface PersonEntry {
  relationships?: string[];
  notes?: string;
}
interface MeetingEntry {
  call_types?: string[];
  notes?: string;
}
interface CompanyEntry {
  relationships?: string[];
  notes?: string;
}
interface LabelsFile {
  people?: Record<string, PersonEntry>;
  meetings?: Record<string, MeetingEntry>;
  companies?: Record<string, CompanyEntry>;
  /** Hand-edited only; preserved across apply-labels merges (not in proposals). */
  skipped?: { people?: string[]; companies?: string[] };
}

function readYamlFile(path: string): LabelsFile {
  if (!existsSync(path)) return {};
  try {
    const raw = parseYaml(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") return {};
    return raw as LabelsFile;
  } catch (err) {
    console.error(`[apply-labels] failed to parse ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Merge a proposals LabelsFile into a labels LabelsFile. Returns a fresh
 * object; does not mutate either input.
 */
function mergeLabels(
  existing: LabelsFile,
  proposed: LabelsFile,
  knownEmails: Set<string>,
  knownMeetingIds: Set<number>,
  knownDomains: Set<string>
): {
  merged: LabelsFile;
  stats: {
    peopleAdded: number;
    peopleTagsAdded: number;
    meetingsAdded: number;
    meetingsTagsAdded: number;
    companiesAdded: number;
    companiesTagsAdded: number;
    warnings: string[];
  };
} {
  const merged: LabelsFile = {
    people: { ...(existing.people ?? {}) },
    meetings: { ...(existing.meetings ?? {}) },
    companies: { ...(existing.companies ?? {}) },
  };
  if (existing.skipped && typeof existing.skipped === "object") {
    const people = Array.isArray(existing.skipped.people)
      ? [...existing.skipped.people]
          .map((s) => String(s).toLowerCase().trim())
          .filter(Boolean)
          .sort()
      : [];
    const companies = Array.isArray(existing.skipped.companies)
      ? [...existing.skipped.companies]
          .map((s) => String(s).toLowerCase().trim())
          .filter(Boolean)
          .sort()
      : [];
    if (people.length > 0 || companies.length > 0) {
      merged.skipped = {};
      if (people.length > 0) merged.skipped.people = people;
      if (companies.length > 0) merged.skipped.companies = companies;
    }
  }
  const stats = {
    peopleAdded: 0,
    peopleTagsAdded: 0,
    meetingsAdded: 0,
    meetingsTagsAdded: 0,
    companiesAdded: 0,
    companiesTagsAdded: 0,
    warnings: [] as string[],
  };

  const ensurePeople = () => (merged.people ??= {});
  const ensureMeetings = () => (merged.meetings ??= {});
  const ensureCompanies = () => (merged.companies ??= {});

  for (const [rawEmail, rawEntry] of Object.entries(proposed.people ?? {})) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const email = String(rawEmail).toLowerCase().trim();
    if (!email) continue;
    if (!knownEmails.has(email)) {
      stats.warnings.push(
        `person:${email} -- not in participants (typo?) -- writing anyway`
      );
    }

    const proposedTags = Array.isArray(rawEntry.relationships)
      ? rawEntry.relationships.map((t: unknown) => String(t).trim()).filter(Boolean)
      : [];
    const validTags = proposedTags.filter((t) => {
      if (isRelationshipTag(t)) return true;
      stats.warnings.push(
        `person:${email} -- unknown relationship "${t}" -- skipped`
      );
      return false;
    });

    if (validTags.length === 0 && !rawEntry.notes) {
      stats.warnings.push(`person:${email} -- empty proposal -- skipped`);
      continue;
    }

    const people = ensurePeople();
    const prev = people[email] ?? {};
    const isNew = !(email in people);

    const prevTags = new Set(prev.relationships ?? []);
    const beforeSize = prevTags.size;
    for (const t of validTags) prevTags.add(t);
    stats.peopleTagsAdded += prevTags.size - beforeSize;

    const nextNotes =
      typeof rawEntry.notes === "string" && rawEntry.notes.trim()
        ? rawEntry.notes.trim()
        : prev.notes;

    people[email] = {
      relationships: [...prevTags].sort(),
      ...(nextNotes ? { notes: nextNotes } : {}),
    };
    if (isNew) stats.peopleAdded++;
  }

  for (const [rawId, rawEntry] of Object.entries(proposed.meetings ?? {})) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const id = Number(rawId);
    if (!Number.isFinite(id) || !Number.isInteger(id)) {
      stats.warnings.push(`meeting:${rawId} -- not an integer -- skipped`);
      continue;
    }
    if (!knownMeetingIds.has(id)) {
      stats.warnings.push(
        `meeting:${id} -- not in meetings table -- writing anyway`
      );
    }

    const proposedTags = Array.isArray(rawEntry.call_types)
      ? rawEntry.call_types.map((t: unknown) => String(t).trim()).filter(Boolean)
      : [];
    const validTags = proposedTags.filter((t) => {
      if (isCallTypeTag(t)) return true;
      stats.warnings.push(
        `meeting:${id} -- unknown call_type "${t}" -- skipped`
      );
      return false;
    });

    if (validTags.length === 0 && !rawEntry.notes) {
      stats.warnings.push(`meeting:${id} -- empty proposal -- skipped`);
      continue;
    }

    const meetings = ensureMeetings();
    const key = String(id);
    const prev = meetings[key] ?? {};
    const isNew = !(key in meetings);

    const prevTags = new Set(prev.call_types ?? []);
    const beforeSize = prevTags.size;
    for (const t of validTags) prevTags.add(t);
    stats.meetingsTagsAdded += prevTags.size - beforeSize;

    const nextNotes =
      typeof rawEntry.notes === "string" && rawEntry.notes.trim()
        ? rawEntry.notes.trim()
        : prev.notes;

    meetings[key] = {
      call_types: [...prevTags].sort(),
      ...(nextNotes ? { notes: nextNotes } : {}),
    };
    if (isNew) stats.meetingsAdded++;
  }

  for (const [rawDomain, rawEntry] of Object.entries(proposed.companies ?? {})) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const domain = String(rawDomain).toLowerCase().trim();
    if (!domain) continue;
    if (!knownDomains.has(domain)) {
      stats.warnings.push(
        `company:${domain} -- not in companies table (typo?) -- writing anyway`
      );
    }

    const proposedTags = Array.isArray(rawEntry.relationships)
      ? rawEntry.relationships.map((t: unknown) => String(t).trim()).filter(Boolean)
      : [];
    const validTags = proposedTags.filter((t) => {
      if (isCompanyRelationshipTag(t)) return true;
      stats.warnings.push(
        `company:${domain} -- unknown company tag "${t}" -- skipped`
      );
      return false;
    });

    if (validTags.length === 0 && !rawEntry.notes) {
      stats.warnings.push(`company:${domain} -- empty proposal -- skipped`);
      continue;
    }

    const companies = ensureCompanies();
    const prev = companies[domain] ?? {};
    const isNew = !(domain in companies);

    const prevTags = new Set(prev.relationships ?? []);
    const beforeSize = prevTags.size;
    for (const t of validTags) prevTags.add(t);
    stats.companiesTagsAdded += prevTags.size - beforeSize;

    const nextNotes =
      typeof rawEntry.notes === "string" && rawEntry.notes.trim()
        ? rawEntry.notes.trim()
        : prev.notes;

    companies[domain] = {
      relationships: [...prevTags].sort(),
      ...(nextNotes ? { notes: nextNotes } : {}),
    };
    if (isNew) stats.companiesAdded++;
  }

  if (merged.people) {
    const sorted: Record<string, PersonEntry> = {};
    for (const k of Object.keys(merged.people).sort()) sorted[k] = merged.people[k];
    merged.people = sorted;
  }
  if (merged.meetings) {
    const sorted: Record<string, MeetingEntry> = {};
    for (const k of Object.keys(merged.meetings).sort((a, b) => Number(a) - Number(b))) {
      sorted[k] = merged.meetings[k];
    }
    merged.meetings = sorted;
  }
  if (merged.companies) {
    const sorted: Record<string, CompanyEntry> = {};
    for (const k of Object.keys(merged.companies).sort()) sorted[k] = merged.companies[k];
    merged.companies = sorted;
  }

  return { merged, stats };
}

/** Render the labels file as a stable, human-editable YAML string. */
function renderLabelsYaml(labels: LabelsFile): string {
  const header = [
    "# config/labels.yml",
    "#",
    "# Source of truth for relationship + call-type + company taxonomy.",
    "# Hand-editable. Merged into by `npm run apply-labels`.",
    "#",
    `# Relationship tags (per person): ${RELATIONSHIP_TAGS.join(", ")}`,
    `# Call-type tags (per meeting):   ${CALL_TYPE_TAGS.join(", ")}`,
    `# Company tags (per domain):      ${COMPANY_RELATIONSHIP_TAGS.join(", ")}`,
    "#",
    "# Auto-derived tags (not authored here):",
    "#   - internal  -- meeting_type != one_or_more_external",
    "#   - advisory  -- every external attendee has advisor_to",
    "#",
    "# skipped: (optional) emails / domains excluded from prep dossiers —",
    "#   reviewed as \"no label needed\". Not merged from proposals.yml.",
    "",
  ].join("\n");

  const root: Record<string, unknown> = {
    people: labels.people ?? {},
    meetings: labels.meetings ?? {},
    companies: labels.companies ?? {},
  };
  if (labels.skipped) {
    const sp = labels.skipped.people ?? [];
    const sc = labels.skipped.companies ?? [];
    if (sp.length > 0 || sc.length > 0) {
      root.skipped = {
        ...(sp.length > 0 ? { people: sp } : {}),
        ...(sc.length > 0 ? { companies: sc } : {}),
      };
    }
  }

  const body = stringifyYaml(
    root,
    {
      indent: 2,
      lineWidth: 0,
      defaultStringType: "QUOTE_DOUBLE",
      defaultKeyType: "PLAIN",
    }
  );
  return header + body;
}

/**
 * Atomic write: write to a sibling temp file, fsync, rename. If the
 * process dies mid-write, the target is untouched (or the temp is
 * orphaned and harmless).
 */
function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Best-effort unified diff via the system `diff` binary. Falls back to a
 * simple "old / new" dump if `diff` isn't on PATH or both inputs are
 * identical. */
function printDiff(oldText: string, newText: string): void {
  if (oldText === newText) {
    console.log("(no changes)");
    return;
  }

  const tmpDir = process.env.TMPDIR ?? "/tmp";
  const a = join(tmpDir, `labels.before.${process.pid}.yml`);
  const b = join(tmpDir, `labels.after.${process.pid}.yml`);
  writeFileSync(a, oldText);
  writeFileSync(b, newText);
  try {
    const r = spawnSync("diff", ["-u", a, b], { encoding: "utf-8" });
    if (r.error) {
      console.log(newText);
      return;
    }
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  } finally {
    try {
      unlinkSync(a);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(b);
    } catch {
      /* ignore */
    }
  }
}

function main() {
  const program = new Command();
  program
    .option(
      "--proposals <path>",
      "Path to proposals file",
      PROPOSALS_PATH
    )
    .option("--labels <path>", "Path to labels file", LABELS_PATH)
    .option("--dry-run", "Print the diff and exit, don't write")
    .option(
      "--clear",
      "Truncate proposals.yml after a successful merge (next dossier run starts clean)"
    )
    .option(
      "--no-transform",
      "Skip re-running `npm run transform` after merge (useful in scripts)"
    )
    .parse();

  const opts = program.opts();

  if (!existsSync(opts.proposals)) {
    console.error(`No proposals file at ${opts.proposals}. Nothing to apply.`);
    process.exit(1);
  }

  const proposed = readYamlFile(opts.proposals);
  const existing = readYamlFile(opts.labels);

  const db = openDb();
  initSchema(db);
  let knownEmails: Set<string>;
  let knownMeetingIds: Set<number>;
  let knownDomains: Set<string>;
  try {
    const emailRows = db
      .prepare(`SELECT email FROM participants`)
      .all() as { email: string }[];
    knownEmails = new Set(emailRows.map((r) => r.email.toLowerCase()));
    const idRows = db
      .prepare(`SELECT recording_id FROM meetings`)
      .all() as { recording_id: number }[];
    knownMeetingIds = new Set(idRows.map((r) => r.recording_id));
    const domainRows = db
      .prepare(`SELECT domain FROM companies`)
      .all() as { domain: string }[];
    knownDomains = new Set(domainRows.map((r) => r.domain.toLowerCase()));
  } finally {
    db.close();
  }

  const { merged, stats } = mergeLabels(
    existing,
    proposed,
    knownEmails,
    knownMeetingIds,
    knownDomains
  );

  const beforeText = existsSync(opts.labels)
    ? readFileSync(opts.labels, "utf-8")
    : "";
  const afterText = renderLabelsYaml(merged);

  console.log(
    `Merging ${opts.proposals} -> ${opts.labels}`
  );
  console.log(
    `  People: +${stats.peopleAdded} new, +${stats.peopleTagsAdded} tag${stats.peopleTagsAdded === 1 ? "" : "s"}`
  );
  console.log(
    `  Meetings: +${stats.meetingsAdded} new, +${stats.meetingsTagsAdded} tag${stats.meetingsTagsAdded === 1 ? "" : "s"}`
  );
  console.log(
    `  Companies: +${stats.companiesAdded} new, +${stats.companiesTagsAdded} tag${stats.companiesTagsAdded === 1 ? "" : "s"}`
  );
  if (stats.warnings.length > 0) {
    console.log(`  ${stats.warnings.length} warning${stats.warnings.length === 1 ? "" : "s"}:`);
    for (const w of stats.warnings.slice(0, 30)) console.log(`    - ${w}`);
    if (stats.warnings.length > 30) {
      console.log(`    ...and ${stats.warnings.length - 30} more`);
    }
  }
  console.log("");
  console.log("--- diff ---");
  printDiff(beforeText, afterText);
  console.log("");

  if (opts.dryRun) {
    console.log("Dry run. No files changed.");
    return;
  }

  if (beforeText === afterText) {
    console.log("No changes to write.");
    return;
  }

  atomicWrite(opts.labels, afterText);
  console.log(`Wrote ${opts.labels}`);

  if (opts.clear) {
    atomicWrite(opts.proposals, "# Proposals cleared after successful apply\n");
    console.log(`Cleared ${opts.proposals}`);
  }

  if (opts.transform !== false) {
    console.log("");
    console.log("Re-running transform to project labels into SQLite + vault...");
    const r = spawnSync("npm", ["run", "transform"], {
      stdio: "inherit",
    });
    if (r.status !== 0) {
      console.error("transform failed; labels.yml was still written.");
      process.exit(r.status ?? 1);
    }
  }
}

main();
