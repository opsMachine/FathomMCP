#!/usr/bin/env tsx
/**
 * prep-calls
 *
 * Mirror of prep-people: builds a self-contained dossier for every unlabeled
 * *external* meeting. Internal-only meetings are skipped because the
 * `internal` call_type is auto-derived on transform.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { openDb, initSchema } from "./lib/db.js";
import {
  loadLabels,
  CALL_TYPE_TAGS,
  CALL_TYPE_DESCRIPTIONS,
} from "./lib/labels.js";
import {
  buildMeetingCandidates,
  countUnlabeledMeetings,
  type MeetingCandidate,
} from "./lib/candidates.js";
import { CANDIDATES_DIR, PROPOSALS_PATH } from "./lib/paths.js";

const DEFAULT_LIMIT = 30;
const DEFAULT_OUT = join(CANDIDATES_DIR, "calls-dossier.md");

interface ProposalsShape {
  people?: Record<string, unknown>;
  meetings?: Record<string | number, unknown>;
}

function loadProposedMeetingIds(): Set<number> {
  if (!existsSync(PROPOSALS_PATH)) return new Set();
  try {
    const raw = parseYaml(readFileSync(PROPOSALS_PATH, "utf-8")) as
      | ProposalsShape
      | null;
    if (!raw || typeof raw !== "object" || !raw.meetings) return new Set();
    const ids = new Set<number>();
    for (const k of Object.keys(raw.meetings)) {
      const n = Number(k);
      if (Number.isFinite(n) && Number.isInteger(n)) ids.add(n);
    }
    return ids;
  } catch (err) {
    console.warn(
      `[prep-calls] could not parse ${PROPOSALS_PATH}: ${(err as Error).message}`
    );
    return new Set();
  }
}

function renderDossier(
  candidates: MeetingCandidate[],
  opts: {
    totalUnlabeled: number;
    myEmail: string | null;
    myDomain: string | null;
  }
): string {
  const lines: string[] = [];

  lines.push("# Call-type labeling dossier");
  lines.push("");
  lines.push(
    `_Generated ${new Date().toISOString()} | ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} of ${opts.totalUnlabeled} unlabeled external meetings._`
  );
  lines.push("");

  lines.push("## Instructions");
  lines.push("");
  lines.push(
    "Read every **Candidate** section below. For each, decide which call-type tag(s) apply (zero or more from the vocabulary)."
  );
  lines.push("");
  lines.push(
    "Append your decisions to `data/proposals.yml` in exactly this shape. **Merge** with any existing content."
  );
  lines.push("");
  lines.push("```yaml");
  lines.push("meetings:");
  lines.push("  12345:");
  lines.push("    call_types: [sales, qualification]");
  lines.push('    notes: "Discovery + pricing pushback"');
  lines.push("  12001:");
  lines.push("    call_types: [demo]");
  lines.push("```");
  lines.push("");
  lines.push("Rules:");
  lines.push(
    "- Only use tags from the vocabulary below. `internal` and `advisory` are auto-derived at transform time -- never apply them manually. `internal` is set when `meeting_type != one_or_more_external`; `advisory` is set when every external attendee has `advisor_to`."
  );
  lines.push(
    "- A meeting can carry multiple call_types (e.g. `[sales, demo]`)."
  );
  lines.push(
    "- Skip a meeting by **omitting** it. Don't write empty `call_types: []`."
  );
  lines.push(
    "- `notes` is optional, private, one line."
  );
  lines.push(
    "- Internal-only meetings are excluded from this dossier entirely."
  );
  lines.push("");

  lines.push("## Canonical call_type tags");
  lines.push("");
  for (const tag of CALL_TYPE_TAGS) {
    const desc = CALL_TYPE_DESCRIPTIONS[tag];
    lines.push(`- **${tag}** -- ${desc}`);
  }
  lines.push("");

  lines.push("## My identity");
  lines.push("");
  if (opts.myEmail) lines.push(`- My email: ${opts.myEmail}`);
  if (opts.myDomain) lines.push(`- My domain: ${opts.myDomain}`);
  lines.push("");

  lines.push("---");
  lines.push("");

  for (const c of candidates) {
    lines.push(`## Candidate: recording_id ${c.recording_id}`);
    lines.push("");
    lines.push(`- Title: ${c.title}`);
    lines.push(`- Date: ${c.date}`);
    if (c.duration_seconds != null) {
      const mins = Math.round(c.duration_seconds / 60);
      lines.push(`- Duration: ~${mins} min`);
    }
    lines.push(`- Meeting type: ${c.meeting_type ?? "unknown"}`);
    lines.push("");

    lines.push("### Participants");
    lines.push("");
    for (const p of c.participants) {
      const tags =
        p.known_relationships.length > 0
          ? ` [${p.known_relationships.join(", ")}]`
          : "";
      const tag = p.is_external ? "external" : "internal";
      lines.push(`- ${p.name} <${p.email}> (${tag})${tags}`);
    }
    lines.push("");

    lines.push("### Summary");
    lines.push("");
    if (c.summary) {
      lines.push(c.summary);
    } else {
      lines.push("_No summary._");
    }
    lines.push("");

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  const program = new Command();
  program
    .option(
      "--limit <n>",
      `Max number of candidates to emit (default ${DEFAULT_LIMIT}).`,
      (v) => parseInt(v, 10),
      DEFAULT_LIMIT
    )
    .option(
      "--all",
      "Emit ALL unlabeled external meetings. Overrides --limit."
    )
    .option(
      "--max-summary-chars <n>",
      "Cap summary length (default 1500).",
      (v) => parseInt(v, 10),
      1500
    )
    .option("--out <path>", "Output path.", DEFAULT_OUT)
    .option(
      "--include-proposed",
      "Also include meetings already staged in data/proposals.yml."
    )
    .parse();

  const opts = program.opts();
  const limit: number | undefined = opts.all ? undefined : opts.limit;

  const db = openDb();
  initSchema(db);
  try {
    const labels = loadLabels();
    const excludeIds = opts.includeProposed ? new Set<number>() : loadProposedMeetingIds();

    const totalUnlabeled = countUnlabeledMeetings(db, labels, excludeIds);

    const candidates = buildMeetingCandidates(db, labels, excludeIds, {
      limit,
      maxSummaryChars: opts.maxSummaryChars,
    });

    const myMeeting = db
      .prepare(
        `SELECT recorded_by_email FROM meetings ORDER BY date DESC LIMIT 1`
      )
      .get() as { recorded_by_email: string } | undefined;
    const myEmail = myMeeting?.recorded_by_email ?? null;
    const myDomain = myEmail ? myEmail.split("@")[1]?.toLowerCase() ?? null : null;

    const markdown = renderDossier(candidates, {
      totalUnlabeled,
      myEmail,
      myDomain,
    });

    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, markdown);

    const remaining = totalUnlabeled - candidates.length;
    console.log(
      `Wrote ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} to ${opts.out}`
    );
    console.log(`  Unlabeled external meetings: ${totalUnlabeled}`);
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
