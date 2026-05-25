import { Command } from "commander";
import { openDb } from "./lib/db.js";
import {
  listMeetings,
  getMeeting,
  findPerson,
  findCompany,
  keywordSearch,
  semanticSearch,
} from "./lib/search.js";

const program = new Command();
program
  .name("fathom-query")
  .description("Query Fathom knowledge base (SQLite + LanceDB)")
  .version("0.1.0");

function formatDuration(sec: number | null): string {
  if (!sec) return "?";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}

function printMeetingRow(m: {
  recording_id: number;
  title: string;
  date: string;
  recorded_by_name: string;
  duration_seconds: number | null;
  meeting_type: string | null;
}) {
  const type = m.meeting_type === "one_or_more_external" ? "ext" : "int";
  console.log(
    `  [${m.recording_id}] ${m.date} (${formatDuration(m.duration_seconds)}, ${type}) -- ${m.title} -- by ${m.recorded_by_name}`
  );
}

program
  .command("list")
  .description("List meetings with optional filters")
  .option("-p, --person <name>", "filter by participant name or email")
  .option("-c, --company <domain>", "filter by company domain")
  .option("--from <YYYY-MM-DD>", "start date")
  .option("--to <YYYY-MM-DD>", "end date")
  .option("-t, --type <type>", "meeting_type (e.g. one_or_more_external, internal_only)")
  .option("-n, --limit <n>", "max rows", "20")
  .action((opts) => {
    const db = openDb();
    const rows = listMeetings(db, {
      person: opts.person,
      company: opts.company,
      dateFrom: opts.from,
      dateTo: opts.to,
      type: opts.type,
      limit: parseInt(opts.limit, 10),
    });
    if (rows.length === 0) {
      console.log("No meetings found.");
    } else {
      console.log(`${rows.length} meetings:`);
      rows.forEach(printMeetingRow);
    }
    db.close();
  });

program
  .command("get <recordingId>")
  .description("Show details for a specific meeting")
  .option("--summary", "include summary markdown")
  .action((recordingId: string, opts) => {
    const db = openDb();
    const meeting = getMeeting(db, parseInt(recordingId, 10));
    if (!meeting) {
      console.error(`No meeting with recording_id=${recordingId}`);
      process.exit(1);
    }
    console.log(`# ${meeting.title}`);
    console.log(
      `Date: ${meeting.date}  Duration: ${formatDuration(meeting.duration_seconds)}  Type: ${meeting.meeting_type ?? "n/a"}`
    );
    console.log(`Recorded by: ${meeting.recorded_by_name} <${meeting.recorded_by_email}>`);
    console.log(`URL: ${meeting.url}`);
    console.log(`Share: ${meeting.share_url}`);
    console.log(`Companies: ${meeting.companies.join(", ") || "(none)"}`);
    console.log(`Participants (${meeting.participants.length}):`);
    for (const p of meeting.participants) {
      console.log(`  - ${p.name} <${p.email}> (${p.meeting_count} total meetings)`);
    }
    if (opts.summary && meeting.summary_markdown) {
      console.log("\n--- Summary ---\n");
      console.log(meeting.summary_markdown);
    }
    db.close();
  });

program
  .command("person <query>")
  .description("Find people by name or email substring")
  .option("-n, --limit <n>", "max rows", "10")
  .option("--meetings", "also show recent meetings with them")
  .action((query: string, opts) => {
    const db = openDb();
    const people = findPerson(db, query, parseInt(opts.limit, 10));
    if (people.length === 0) {
      console.log("No people found.");
    } else {
      for (const p of people) {
        console.log(
          `- ${p.name} <${p.email}>${p.domain ? ` @ ${p.domain}` : ""} -- ${p.meeting_count} meetings (${p.first_seen.split("T")[0]} to ${p.last_seen.split("T")[0]})`
        );
        if (opts.meetings) {
          const meetings = listMeetings(db, { person: p.email, limit: 5 });
          meetings.forEach(printMeetingRow);
          console.log();
        }
      }
    }
    db.close();
  });

program
  .command("company <query>")
  .description("Find companies by domain substring")
  .option("-n, --limit <n>", "max rows", "10")
  .option("--meetings", "also show recent meetings")
  .action((query: string, opts) => {
    const db = openDb();
    const companies = findCompany(db, query, parseInt(opts.limit, 10));
    if (companies.length === 0) {
      console.log("No companies found.");
    } else {
      for (const c of companies) {
        console.log(
          `- ${c.domain} -- ${c.meeting_count} meetings, ${c.contact_count} contacts (${c.first_seen.split("T")[0]} to ${c.last_seen.split("T")[0]})`
        );
        if (opts.meetings) {
          const meetings = listMeetings(db, { company: c.domain, limit: 5 });
          meetings.forEach(printMeetingRow);
          console.log();
        }
      }
    }
    db.close();
  });

program
  .command("keyword <query>")
  .description("Full-text search over meeting titles + summaries")
  .option("-n, --limit <n>", "max rows", "15")
  .action((query: string, opts) => {
    const db = openDb();
    const rows = keywordSearch(db, query, parseInt(opts.limit, 10));
    if (rows.length === 0) {
      console.log("No matches.");
    } else {
      for (const r of rows) {
        console.log(`\n[${r.recording_id}] ${r.date} -- ${r.title}`);
        console.log(`  ${r.snippet.replace(/\s+/g, " ")}`);
      }
    }
    db.close();
  });

program
  .command("search <query...>")
  .description("Semantic search across transcripts + summaries")
  .option("-n, --limit <n>", "max hits", "8")
  .option("-p, --person <name>", "scope to meetings with this person")
  .option("-c, --company <domain>", "scope to meetings with this company")
  .option("--from <YYYY-MM-DD>", "start date")
  .option("--to <YYYY-MM-DD>", "end date")
  .option("--context", "print full chunk text")
  .action(async (queryWords: string[], opts) => {
    const q = queryWords.join(" ");
    const hits = await semanticSearch(q, {
      limit: parseInt(opts.limit, 10),
      person: opts.person,
      company: opts.company,
      dateFrom: opts.from,
      dateTo: opts.to,
    });
    if (hits.length === 0) {
      console.log("No results.");
      return;
    }
    for (const h of hits) {
      const ts = h.start_timestamp ? ` @${h.start_timestamp}` : "";
      console.log(
        `\n[${h.recording_id}] ${h.meeting_date} (${h.kind}${ts}) distance=${h.distance.toFixed(3)}`
      );
      console.log(`  ${h.meeting_title}`);
      console.log(`  participants: ${h.participants}`);
      const preview = opts.context
        ? h.text
        : h.text.split("\n").slice(0, 3).join(" / ").slice(0, 400) + (h.text.length > 400 ? "..." : "");
      console.log(`  ${preview}`);
    }
  });

program
  .command("context <query...>")
  .description("Build a copy-paste-ready AI prompt context block")
  .option("-n, --limit <n>", "chunks to include", "6")
  .option("-p, --person <name>", "scope")
  .option("-c, --company <domain>", "scope")
  .option("--from <YYYY-MM-DD>", "start date")
  .option("--to <YYYY-MM-DD>", "end date")
  .action(async (queryWords: string[], opts) => {
    const q = queryWords.join(" ");
    const hits = await semanticSearch(q, {
      limit: parseInt(opts.limit, 10),
      person: opts.person,
      company: opts.company,
      dateFrom: opts.from,
      dateTo: opts.to,
    });

    console.log(`# Context for: "${q}"\n`);
    if (hits.length === 0) {
      console.log("_No matching chunks._");
      return;
    }
    hits.forEach((h, i) => {
      console.log(`## [${i + 1}] ${h.meeting_title} (${h.meeting_date})`);
      console.log(
        `- recording_id: ${h.recording_id} | kind: ${h.kind} | speakers: ${h.speakers}`
      );
      console.log(`- participants: ${h.participants}`);
      if (h.start_timestamp)
        console.log(`- timestamp: ${h.start_timestamp}${h.end_timestamp ? ` -> ${h.end_timestamp}` : ""}`);
      console.log();
      console.log(h.text);
      console.log();
    });
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
