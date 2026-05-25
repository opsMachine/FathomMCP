#!/usr/bin/env tsx
/**
 * prep-people (dossier v2)
 *
 * Triaged markdown dossier of unlabeled people. Auto-skips obvious noise
 * (role inboxes with no signal, 1-meeting cold contacts, my own domain),
 * drafts org-tag inheritance proposals, surfaces only mid-confidence
 * candidates for human review.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { openDb, initSchema } from "./lib/db.js";
import {
  loadLabels,
  RELATIONSHIP_TAGS,
  RELATIONSHIP_DESCRIPTIONS,
} from "./lib/labels.js";
import {
  buildPersonCandidates,
  countUnlabeledPeople,
  type PersonCandidate,
} from "./lib/candidates.js";
import {
  triagePerson,
  bucketPeople,
  type PersonTriage,
  type TriageBuckets,
} from "./lib/triage.js";
import { CANDIDATES_DIR, PROPOSALS_PATH } from "./lib/paths.js";

const DEFAULT_LIMIT = 30;
const DEFAULT_OUT = join(CANDIDATES_DIR, "people-dossier.md");

interface ProposalsShape {
  people?: Record<string, unknown>;
  meetings?: Record<string, unknown>;
  companies?: Record<string, unknown>;
}

function loadProposalsFile(): ProposalsShape {
  if (!existsSync(PROPOSALS_PATH)) return {};
  try {
    const raw = parseYaml(readFileSync(PROPOSALS_PATH, "utf-8")) as
      | ProposalsShape
      | null;
    return raw && typeof raw === "object" ? raw : {};
  } catch (err) {
    console.warn(
      `[prep-people] could not parse ${PROPOSALS_PATH}: ${(err as Error).message}`
    );
    return {};
  }
}

function loadProposedEmails(): Set<string> {
  const raw = loadProposalsFile();
  if (!raw.people) return new Set();
  return new Set(
    Object.keys(raw.people).map((e) => e.toLowerCase().trim())
  );
}

function renderDraftYaml(drafts: PersonTriage[]): string {
  const obj: Record<string, unknown> = {};
  for (const d of drafts) {
    obj[d.email] = {
      relationships: d.suggested,
      notes: `[draft] ${d.reason}`,
    };
  }
  return stringifyYaml({ people: obj });
}

function renderDossier(
  candidates: PersonCandidate[],
  buckets: TriageBuckets<PersonTriage>,
  opts: {
    totalUnlabeled: number;
    myEmail: string | null;
    myDomain: string | null;
    includeLow: boolean;
    acceptedDrafts: boolean;
  }
): string {
  const lines: string[] = [];

  lines.push("# People labeling dossier (v2)");
  lines.push("");
  lines.push(
    `_Generated ${new Date().toISOString()} | ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} of ${opts.totalUnlabeled} unlabeled total._`
  );
  lines.push("");

  lines.push("## Triage summary");
  lines.push("");
  lines.push(`- **Drafted (A_PROPOSE)**: ${buckets.draft.length} — ${opts.acceptedDrafts ? "auto-merged into proposals.yml" : "review the yaml block below; copy if good"}`);
  lines.push(`- **Review queue (B)**: ${buckets.review.length} — full context below`);
  lines.push(`- **Auto-skipped (A_SKIP)**: ${buckets.skip.length} — out of scope (my own domain, cold contacts, role inboxes)`);
  lines.push(`- **Low-signal (C)**: ${buckets.low.length} — hidden${opts.includeLow ? " (shown below; --include-low)" : "; rerun with --include-low to surface"}`);
  lines.push("");

  if (buckets.draft.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Drafted proposals");
    lines.push("");
    if (opts.acceptedDrafts) {
      lines.push("These were **auto-merged** into `data/proposals.yml`. Review the diff via `npm run apply-labels -- --dry-run` before applying.");
    } else {
      lines.push("Copy this yaml block into `data/proposals.yml` under the `people:` section if the suggestions look right.");
    }
    lines.push("");
    lines.push("```yaml");
    lines.push(renderDraftYaml(buckets.draft).trimEnd());
    lines.push("```");
    lines.push("");
    lines.push("Per-draft reasoning:");
    lines.push("");
    for (const d of buckets.draft) {
      lines.push(`- **${d.email}** → ${d.suggested.join(", ") || "(none)"} — ${d.reason}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Review queue");
  lines.push("");
  if (buckets.review.length === 0) {
    lines.push("_No candidates need review in this batch._");
    lines.push("");
  } else {
    lines.push(
      "These have signals but no high-confidence default. Add to `data/proposals.yml` under `people:` (skip by omitting)."
    );
    lines.push("");
    for (const t of buckets.review) {
      const c = candidates.find((x) => x.email.toLowerCase() === t.email.toLowerCase());
      if (!c) continue;
      renderCandidate(lines, c, t);
    }
  }

  if (opts.includeLow && buckets.low.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Low-signal candidates (--include-low)");
    lines.push("");
    for (const t of buckets.low) {
      const c = candidates.find((x) => x.email.toLowerCase() === t.email.toLowerCase());
      if (!c) continue;
      renderCandidate(lines, c, t);
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("## Vocabulary reference");
  lines.push("");
  for (const tag of RELATIONSHIP_TAGS) {
    lines.push(`- **${tag}** — ${RELATIONSHIP_DESCRIPTIONS[tag]}`);
  }
  lines.push("");

  if (opts.myEmail || opts.myDomain) {
    lines.push("## My identity");
    lines.push("");
    if (opts.myEmail) lines.push(`- Email: ${opts.myEmail}`);
    if (opts.myDomain) lines.push(`- Domain: ${opts.myDomain}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderCandidate(
  lines: string[],
  c: PersonCandidate,
  t: PersonTriage
): void {
  lines.push(`### ${c.name} <${c.email}>`);
  lines.push("");
  const sigParts: string[] = [];
  if (t.signals.recency_days !== null)
    sigParts.push(`last ${t.signals.recency_days}d ago`);
  sigParts.push(`${c.meeting_count} meeting${c.meeting_count === 1 ? "" : "s"}`);
  sigParts.push(c.is_external ? "external" : "internal");
  if (t.signals.org_label)
    sigParts.push(`org tagged: ${t.signals.org_label}`);
  if (t.signals.keyword_hits.length > 0)
    sigParts.push(`signals: ${t.signals.keyword_hits.join(", ")}`);
  if (t.signals.title_hits.length > 0)
    sigParts.push(`titles: ${t.signals.title_hits.join(", ")}`);
  lines.push(`> _${sigParts.join(" • ")}_`);
  lines.push("");
  const colleagueDist = Object.entries(t.signals.org_person_distribution);
  const distinctColleagueTags = colleagueDist.length;
  const conflictWithColleagues =
    distinctColleagueTags > 1 ||
    (distinctColleagueTags === 1 &&
      t.signals.org_label !== null &&
      colleagueDist[0]?.[0] !== t.signals.org_label);
  if (conflictWithColleagues) {
    const dist = colleagueDist
      .sort((a, b) => b[1] - a[1])
      .map(([tag, n]) => `\`${tag}\`×${n}`)
      .join(", ");
    const orgPart = t.signals.org_label
      ? ` (org default: \`${t.signals.org_label}\`)`
      : "";
    lines.push(`> ⚠ **Conflict**: colleagues at this domain carry mixed tags — ${dist}${orgPart}`);
    lines.push("");
  }
  if (t.suggested.length > 0) {
    lines.push(`**Suggested**: \`${t.suggested.join(", ")}\` — ${t.reason}`);
    lines.push("");
  } else if (t.reason) {
    lines.push(`_${t.reason}_`);
    lines.push("");
  }

  if (c.co_attendees_known.length > 0) {
    lines.push(`**Co-attendees with known labels** (${c.co_attendees_known.length}):`);
    for (const co of c.co_attendees_known.slice(0, 8)) {
      lines.push(`- ${co.name} <${co.email}> [${co.relationships.join(", ")}]`);
    }
    if (c.co_attendees_known.length > 8) {
      lines.push(`- ... +${c.co_attendees_known.length - 8} more`);
    }
    lines.push("");
  }

  lines.push(
    `**Recent meetings** (${c.meetings.length}${c.omitted_meeting_count > 0 ? `, +${c.omitted_meeting_count} older` : ""}):`
  );
  lines.push("");
  for (const m of c.meetings) {
    lines.push(`#### ${m.date} — ${m.title} (recording_id: ${m.recording_id})`);
    lines.push("");
    if (m.summary) lines.push(m.summary);
    else lines.push("_No summary._");
    lines.push("");
  }
  lines.push("---");
  lines.push("");
}

function mergeDraftsIntoProposals(drafts: PersonTriage[]): {
  added: number;
  skipped: number;
} {
  const raw = loadProposalsFile();
  const people = (raw.people as Record<string, unknown> | undefined) ?? {};
  let added = 0;
  let skipped = 0;
  for (const d of drafts) {
    if (people[d.email]) {
      skipped++;
      continue;
    }
    people[d.email] = {
      relationships: d.suggested,
      notes: `[draft] ${d.reason}`,
    };
    added++;
  }
  raw.people = people;
  const out: ProposalsShape = {
    people: raw.people,
    meetings: raw.meetings ?? {},
    companies: raw.companies ?? {},
  };

  const header = `# data/proposals.yml
#
# Staging area for label decisions, merged into config/labels.yml by
# \`npm run apply-labels\` (atomic write + printed diff).
#
# This file is gitignored and truncated after a successful apply (--clear).
`;
  writeFileSync(PROPOSALS_PATH, header + "\n" + stringifyYaml(out));
  return { added, skipped };
}

function main() {
  const program = new Command();
  program
    .option(
      "--limit <n>",
      `Max number of candidates to triage (default ${DEFAULT_LIMIT}).`,
      (v) => parseInt(v, 10),
      DEFAULT_LIMIT
    )
    .option(
      "--all",
      "Triage ALL unlabeled candidates. Overrides --limit."
    )
    .option(
      "--max-summary-chars <n>",
      "Cap per-meeting summary length (default 1500).",
      (v) => parseInt(v, 10),
      1500
    )
    .option(
      "--meetings-per-person <n>",
      "Most recent N meetings to include per person (default 8).",
      (v) => parseInt(v, 10),
      8
    )
    .option("--out <path>", "Output path.", DEFAULT_OUT)
    .option(
      "--include-proposed",
      "Also include candidates already staged in data/proposals.yml."
    )
    .option(
      "--include-low",
      "Show low-signal (C) candidates inline instead of count-only."
    )
    .option(
      "--accept-drafts",
      "Auto-merge A_PROPOSE drafts into data/proposals.yml."
    )
    .parse();

  const opts = program.opts();
  const limit: number | undefined = opts.all ? undefined : opts.limit;

  const db = openDb();
  initSchema(db);
  try {
    const labels = loadLabels();
    const excludeEmails = opts.includeProposed
      ? new Set<string>()
      : loadProposedEmails();

    const totalUnlabeled = countUnlabeledPeople(db, labels, excludeEmails);

    const candidates = buildPersonCandidates(db, labels, excludeEmails, {
      limit,
      meetingsPerPerson: opts.meetingsPerPerson,
      maxSummaryChars: opts.maxSummaryChars,
    });

    const myMeeting = db
      .prepare(
        `SELECT recorded_by_email FROM meetings ORDER BY date DESC LIMIT 1`
      )
      .get() as { recorded_by_email: string } | undefined;
    const myEmail = myMeeting?.recorded_by_email ?? null;
    const myDomain = myEmail
      ? myEmail.split("@")[1]?.toLowerCase() ?? null
      : null;

    const today = new Date();
    const triages = candidates.map((c) =>
      triagePerson(c, labels, { today, myDomain })
    );
    const buckets = bucketPeople(triages);

    let acceptedDrafts = false;
    if (opts.acceptDrafts && buckets.draft.length > 0) {
      const result = mergeDraftsIntoProposals(buckets.draft);
      acceptedDrafts = true;
      console.log(
        `Auto-merged ${result.added} drafts into proposals.yml (${result.skipped} skipped — already proposed).`
      );
    }

    const markdown = renderDossier(candidates, buckets, {
      totalUnlabeled,
      myEmail,
      myDomain,
      includeLow: !!opts.includeLow,
      acceptedDrafts,
    });

    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, markdown);

    const remaining = totalUnlabeled - candidates.length;
    console.log(
      `Wrote ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} to ${opts.out}`
    );
    console.log(
      `  Drafted: ${buckets.draft.length}, Review: ${buckets.review.length}, Auto-skipped: ${buckets.skip.length}, Low-signal: ${buckets.low.length}`
    );
    console.log(`  Unlabeled total: ${totalUnlabeled}`);
    if (remaining > 0) {
      console.log(
        `  Remaining after this pass: ${remaining} (re-run after applying proposals.yml)`
      );
    }
  } finally {
    db.close();
  }
}

main();
