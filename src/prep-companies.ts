#!/usr/bin/env tsx
/**
 * prep-companies (dossier v2)
 *
 * Build a triaged markdown dossier of unlabeled company domains. Auto-skips
 * obvious noise, drafts high-confidence proposals (is_self / inheritance
 * from labeled people), surfaces only mid-confidence candidates for human
 * review, and hides low-signal candidates behind a count.
 *
 * Output structure:
 *   1. Header: counts per bucket (draft / review / skipped / low-signal)
 *   2. Drafted proposals -- A_PROPOSE candidates as a copy-pastable yaml
 *      block (or auto-merged into proposals.yml if --accept-drafts)
 *   3. Review queue -- B candidates with full context
 *   4. Hidden buckets summary at the bottom
 *
 * Idempotent: skips domains already in config/labels.yml or proposals.yml.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { openDb, initSchema } from "./lib/db.js";
import {
  loadLabels,
  COMPANY_RELATIONSHIP_TAGS,
  COMPANY_RELATIONSHIP_DESCRIPTIONS,
} from "./lib/labels.js";
import {
  buildCompanyCandidates,
  countUnlabeledCompanies,
  type CompanyCandidate,
} from "./lib/candidates.js";
import {
  triageCompany,
  bucketCompanies,
  type CompanyTriage,
  type TriageBuckets,
} from "./lib/triage.js";
import { CANDIDATES_DIR, PROPOSALS_PATH } from "./lib/paths.js";

const DEFAULT_LIMIT = 30;
const DEFAULT_OUT = join(CANDIDATES_DIR, "companies-dossier.md");

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
      `[prep-companies] could not parse ${PROPOSALS_PATH}: ${(err as Error).message}`
    );
    return {};
  }
}

function loadProposedDomains(): Set<string> {
  const raw = loadProposalsFile();
  if (!raw.companies) return new Set();
  return new Set(Object.keys(raw.companies).map((d) => d.toLowerCase().trim()));
}

function renderDraftYaml(drafts: CompanyTriage[]): string {
  const obj: Record<string, unknown> = {};
  for (const d of drafts) {
    obj[d.domain] = {
      relationships: d.suggested,
      notes: `[draft] ${d.reason}`,
    };
  }
  return stringifyYaml({ companies: obj });
}

function renderDossier(
  candidates: CompanyCandidate[],
  buckets: TriageBuckets<CompanyTriage>,
  triageByDomain: Map<string, CompanyTriage>,
  opts: {
    totalUnlabeled: number;
    myEmail: string | null;
    myDomain: string | null;
    includeLow: boolean;
    acceptedDrafts: boolean;
  }
): string {
  const lines: string[] = [];

  lines.push("# Companies labeling dossier (v2)");
  lines.push("");
  lines.push(
    `_Generated ${new Date().toISOString()} | ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} of ${opts.totalUnlabeled} unlabeled total._`
  );
  lines.push("");

  lines.push("## Triage summary");
  lines.push("");
  lines.push(`- **Drafted (A_PROPOSE)**: ${buckets.draft.length} — ${opts.acceptedDrafts ? "auto-merged into proposals.yml" : "review the yaml block below; copy into proposals.yml if good"}`);
  lines.push(`- **Review queue (B)**: ${buckets.review.length} — full context below`);
  lines.push(`- **Auto-skipped (A_SKIP)**: ${buckets.skip.length} — clearly out of scope (1-meeting cold contacts, role inboxes, etc.)`);
  lines.push(`- **Low-signal (C)**: ${buckets.low.length} — hidden${opts.includeLow ? " (shown below; --include-low)" : "; rerun with --include-low to surface"}`);
  lines.push("");

  if (buckets.draft.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Drafted proposals");
    lines.push("");
    if (opts.acceptedDrafts) {
      lines.push("These were **auto-merged** into `data/proposals.yml`. Review them in the diff before running `npm run apply-labels`.");
    } else {
      lines.push("Copy this yaml block into `data/proposals.yml` under the `companies:` section if the suggestions look right. Edit notes / tags freely before applying.");
    }
    lines.push("");
    lines.push("```yaml");
    lines.push(renderDraftYaml(buckets.draft).trimEnd());
    lines.push("```");
    lines.push("");
    lines.push("Per-draft reasoning:");
    lines.push("");
    for (const d of buckets.draft) {
      lines.push(`- **${d.domain}** → ${d.suggested.join(", ") || "(none)"} — ${d.reason}`);
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
      "These have signals but no high-confidence default. Add to `data/proposals.yml` under `companies:` (skip by omitting)."
    );
    lines.push("");
    lines.push("```yaml");
    lines.push("companies:");
    lines.push("  acme.com:");
    lines.push("    relationships: [client_org]");
    lines.push('    notes: "..."');
    lines.push("```");
    lines.push("");

    for (const t of buckets.review) {
      const c = candidates.find((x) => x.domain === t.domain);
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
      const c = candidates.find((x) => x.domain === t.domain);
      if (!c) continue;
      renderCandidate(lines, c, t);
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("## Vocabulary reference");
  lines.push("");
  for (const tag of COMPANY_RELATIONSHIP_TAGS) {
    lines.push(`- **${tag}** — ${COMPANY_RELATIONSHIP_DESCRIPTIONS[tag]}`);
  }
  lines.push("");

  if (opts.myEmail || opts.myDomain) {
    lines.push("## My identity");
    lines.push("");
    if (opts.myEmail) lines.push(`- Email: ${opts.myEmail}`);
    if (opts.myDomain) lines.push(`- Domain: ${opts.myDomain}`);
    lines.push("");
  }

  // Suppress unused-import-style lint by referencing triageByDomain (used in render path
  // when re-deriving signals; keeping the parameter for future per-candidate footers).
  void triageByDomain;

  return lines.join("\n");
}

function renderCandidate(
  lines: string[],
  c: CompanyCandidate,
  t: CompanyTriage
): void {
  lines.push(`### ${c.domain}`);
  lines.push("");
  const sigParts: string[] = [];
  if (t.signals.recency_days !== null)
    sigParts.push(`last ${t.signals.recency_days}d ago`);
  sigParts.push(`${c.meeting_count} meeting${c.meeting_count === 1 ? "" : "s"}`);
  sigParts.push(`${c.contact_count} contact${c.contact_count === 1 ? "" : "s"}`);
  if (t.signals.keyword_hits.length > 0)
    sigParts.push(`signals: ${t.signals.keyword_hits.join(", ")}`);
  if (t.signals.title_hits.length > 0)
    sigParts.push(`titles: ${t.signals.title_hits.join(", ")}`);
  lines.push(`> _${sigParts.join(" • ")}_`);
  lines.push("");
  const distEntries = Object.entries(t.signals.person_tag_distribution);
  const distinctTags = distEntries.length;
  const suggestedOrgTag = t.suggested[0] ?? null;
  const suggestedDisagreesWithPeople =
    suggestedOrgTag !== null &&
    distinctTags > 0 &&
    !(suggestedOrgTag in t.signals.person_tag_distribution);
  if (t.signals.has_inheritance_conflict || suggestedDisagreesWithPeople) {
    const dist = distEntries
      .sort((a, b) => b[1] - a[1])
      .map(([tag, n]) => `\`${tag}\`×${n}`)
      .join(", ");
    if (t.signals.has_inheritance_conflict) {
      lines.push(`> ⚠ **Conflict**: labeled people carry mixed tags — ${dist}`);
    } else {
      lines.push(
        `> ⚠ **Conflict**: suggested \`${suggestedOrgTag}\` but labeled person carries ${dist} — confirm whether the org and the contact share the same relationship`
      );
    }
    lines.push("");
  }
  if (t.suggested.length > 0) {
    lines.push(`**Suggested**: \`${t.suggested.join(", ")}\` — ${t.reason}`);
    lines.push("");
  }

  if (c.people.length > 0) {
    lines.push(
      `**People** (${c.people.length}${c.omitted_people_count > 0 ? `, +${c.omitted_people_count} more` : ""}):`
    );
    for (const p of c.people) {
      const tagStr =
        p.relationships.length > 0
          ? ` [${p.relationships.join(", ")}]`
          : " _(unlabeled)_";
      lines.push(`- ${p.name} <${p.email}> — ${p.meeting_count} mtg${p.meeting_count === 1 ? "" : "s"}${tagStr}`);
    }
    lines.push("");
  }

  if (c.representative_meetings.length > 0) {
    lines.push(
      `**Recent meetings** (${c.representative_meetings.length}${c.omitted_meeting_count > 0 ? `, +${c.omitted_meeting_count} older` : ""}):`
    );
    lines.push("");
    for (const m of c.representative_meetings) {
      lines.push(`#### ${m.date} — ${m.title} (recording_id: ${m.recording_id})`);
      lines.push("");
      if (m.summary) lines.push(m.summary);
      else lines.push("_No summary._");
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("");
}

/**
 * Merge drafted company proposals into data/proposals.yml. Preserves existing
 * content. Skips domains already proposed (don't overwrite manual edits).
 */
function mergeDraftsIntoProposals(drafts: CompanyTriage[]): {
  added: number;
  skipped: number;
} {
  const raw = loadProposalsFile();
  const companies = (raw.companies as Record<string, unknown> | undefined) ?? {};
  let added = 0;
  let skipped = 0;
  for (const d of drafts) {
    if (companies[d.domain]) {
      skipped++;
      continue;
    }
    companies[d.domain] = {
      relationships: d.suggested,
      notes: `[draft] ${d.reason}`,
    };
    added++;
  }
  raw.companies = companies;

  const out: ProposalsShape = {
    people: raw.people ?? {},
    meetings: raw.meetings ?? {},
    companies: raw.companies,
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
      "--people-per-company <n>",
      "Top N people to list per company (default 10).",
      (v) => parseInt(v, 10),
      10
    )
    .option(
      "--meetings-per-company <n>",
      "Most recent N meetings to include per company (default 5).",
      (v) => parseInt(v, 10),
      5
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
      "Auto-merge A_PROPOSE drafts into data/proposals.yml (still requires apply-labels to push to config)."
    )
    .parse();

  const opts = program.opts();
  const limit: number | undefined = opts.all ? undefined : opts.limit;

  const db = openDb();
  initSchema(db);
  try {
    const labels = loadLabels();
    const excludeDomains = opts.includeProposed
      ? new Set<string>()
      : loadProposedDomains();

    const totalUnlabeled = countUnlabeledCompanies(db, labels, excludeDomains);

    const candidates = buildCompanyCandidates(db, labels, excludeDomains, {
      limit,
      peoplePerCompany: opts.peoplePerCompany,
      meetingsPerCompany: opts.meetingsPerCompany,
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
      triageCompany(c, { today, myDomain })
    );
    const buckets = bucketCompanies(triages);
    const triageByDomain = new Map(triages.map((t) => [t.domain, t]));

    let acceptedDrafts = false;
    if (opts.acceptDrafts && buckets.draft.length > 0) {
      const result = mergeDraftsIntoProposals(buckets.draft);
      acceptedDrafts = true;
      console.log(
        `Auto-merged ${result.added} drafts into proposals.yml (${result.skipped} skipped — already proposed).`
      );
    }

    const markdown = renderDossier(candidates, buckets, triageByDomain, {
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
