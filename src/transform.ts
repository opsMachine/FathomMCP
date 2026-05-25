import { config } from "dotenv";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { Meeting } from "./lib/types.js";
import { openDb, initSchema, clearAll } from "./lib/db.js";
import {
  loadLabels,
  applyLabelsToSqlite,
  type Labels,
  type CallTypeTag,
  type RelationshipTag,
} from "./lib/labels.js";
import type Database from "better-sqlite3";
import {
  RAW_DIR,
  MEETINGS_DIR,
  PEOPLE_DIR,
  COMPANIES_DIR,
} from "./lib/paths.js";

config();

mkdirSync(MEETINGS_DIR, { recursive: true });
mkdirSync(PEOPLE_DIR, { recursive: true });
mkdirSync(COMPANIES_DIR, { recursive: true });

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function formatTimestamp(ts: string): string {
  const parts = ts.split(":");
  if (parts.length === 3) {
    const [h, m, s] = parts;
    const hours = parseInt(h, 10);
    const mins = parseInt(m, 10);
    const secs = parseFloat(s);
    if (hours > 0) return `${hours}:${String(mins).padStart(2, "0")}:${String(Math.floor(secs)).padStart(2, "0")}`;
    return `${mins}:${String(Math.floor(secs)).padStart(2, "0")}`;
  }
  return ts;
}

function extractDomain(email: string): string | null {
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase();
  const generic = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "icloud.com", "aol.com", "protonmail.com", "mail.com",
  ];
  if (generic.includes(domain)) return null;
  return domain;
}

interface PersonRecord {
  name: string;
  email: string;
  domain: string | null;
  meetingIds: number[];
}

interface CompanyRecord {
  domain: string;
  meetingIds: number[];
  people: Set<string>;
}

/**
 * Compute auto-derived call types for a meeting.
 *
 * Auto-derivations are NOT persisted to config/labels.yml; they're computed
 * fresh on every transform so the source-of-truth file stays minimal.
 *
 * Externality is derived from participant domains, not from the raw
 * `meeting_type` field (which is often null in the Fathom payload).
 *
 * - `internal`: meeting has zero participants with a non-generic domain
 *   different from the recorder's domain.
 * - `advisory`: meeting has at least one external participant AND every
 *   external participant carries an `advisor_to` relationship tag.
 */
function deriveCallTypes(meeting: Meeting, labels: Labels): CallTypeTag[] {
  const derived: CallTypeTag[] = [];

  const myDomain = extractDomain(meeting.recorded_by.email);
  const externals: string[] = [];
  for (const inv of meeting.calendar_invitees) {
    const d = extractDomain(inv.email);
    if (d && d !== myDomain) externals.push(inv.email.toLowerCase());
  }

  if (externals.length === 0) {
    derived.push("internal");
    return derived;
  }

  const everyExternalIsAdvised = externals.every((email) => {
    const entry = labels.people.get(email);
    return entry?.relationships.includes("advisor_to");
  });
  if (everyExternalIsAdvised) derived.push("advisory");

  return derived;
}

function buildMeetingMarkdown(meeting: Meeting, labels: Labels): string {
  const date = meeting.created_at.split("T")[0];
  const participants = meeting.calendar_invitees.map((inv) => ({
    name: inv.name || inv.email.split("@")[0],
    email: inv.email,
    domain: extractDomain(inv.email),
  }));

  const domains = [
    ...new Set(participants.map((p) => p.domain).filter(Boolean)),
  ] as string[];

  const participantNames = participants.map((p) => p.name);

  const authored = labels.meetings.get(meeting.recording_id)?.call_types ?? [];
  const derived = deriveCallTypes(meeting, labels);
  const callTypes = [...new Set([...authored, ...derived])];

  const lines: string[] = [];

  lines.push("---");
  lines.push(`recording_id: ${meeting.recording_id}`);
  lines.push(`title: ${JSON.stringify(meeting.title)}`);
  lines.push(`date: "${date}"`);
  lines.push(`url: "${meeting.url}"`);
  lines.push(`share_url: "${meeting.share_url}"`);
  lines.push(`recorded_by: "${meeting.recorded_by.email}"`);
  lines.push(`type: "${meeting.calendar_invitees_domains_type ?? ""}"`);
  lines.push(`language: "${meeting.transcript_language}"`);
  if (meeting.recording_start_time)
    lines.push(`recording_start: "${meeting.recording_start_time}"`);
  if (meeting.recording_end_time)
    lines.push(`recording_end: "${meeting.recording_end_time}"`);
  lines.push("participants:");
  for (const p of participantNames) {
    lines.push(`  - "${p}"`);
  }
  if (domains.length > 0) {
    lines.push("companies:");
    for (const d of domains) {
      lines.push(`  - "${d}"`);
    }
  }
  if (callTypes.length > 0) {
    lines.push("call_types:");
    for (const ct of callTypes) {
      lines.push(`  - "${ct}"`);
    }
  }
  lines.push("tags:");
  lines.push("  - meeting");
  if (meeting.calendar_invitees_domains_type === "one_or_more_external")
    lines.push("  - external");
  else lines.push("  - internal");
  lines.push("---");
  lines.push("");
  lines.push(`# ${meeting.title}`);
  lines.push("");
  lines.push(
    `**Date:** ${date} | **Recorded by:** ${meeting.recorded_by.name} | **Participants:** ${participantNames.join(", ")}`
  );
  if (domains.length > 0) {
    lines.push(`**Companies:** ${domains.join(", ")}`);
  }
  lines.push("");

  if (meeting.default_summary?.markdown_formatted) {
    lines.push("## Summary");
    lines.push("");
    lines.push(meeting.default_summary.markdown_formatted);
    lines.push("");
  }

  if (meeting.transcript && meeting.transcript.length > 0) {
    lines.push("## Transcript");
    lines.push("");
    for (const entry of meeting.transcript) {
      const speaker = entry.speaker.name || entry.speaker.email || "Unknown";
      const ts = formatTimestamp(entry.timestamp);
      lines.push(`**${speaker}** [${ts}]: ${entry.text}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildPersonMarkdown(
  person: PersonRecord,
  allMeetings: Map<number, Meeting>,
  labels: Labels
): string {
  const lines: string[] = [];
  const entry = labels.people.get(person.email.toLowerCase());
  const relationships = entry?.relationships ?? [];

  lines.push("---");
  lines.push(`name: "${person.name}"`);
  lines.push(`email: "${person.email}"`);
  if (person.domain) lines.push(`company: "${person.domain}"`);
  lines.push(`meeting_count: ${person.meetingIds.length}`);
  if (relationships.length > 0) {
    lines.push("relationships:");
    for (const r of relationships) lines.push(`  - "${r}"`);
  }
  if (entry?.notes) lines.push(`notes: ${JSON.stringify(entry.notes)}`);
  lines.push("tags:");
  lines.push("  - person");
  for (const r of relationships) lines.push(`  - "${r}"`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${person.name}`);
  lines.push("");
  lines.push(`**Email:** ${person.email}`);
  if (person.domain) lines.push(`**Company:** ${person.domain}`);
  lines.push(`**Meetings:** ${person.meetingIds.length}`);
  if (relationships.length > 0) {
    lines.push(`**Relationships:** ${relationships.join(", ")}`);
  }
  lines.push("");
  lines.push("## Meeting History");
  lines.push("");
  lines.push(
    "<!-- Opaque recording_id links; meeting titles and dates live only in the gitignored vault/Meetings/ files. -->"
  );
  lines.push("");

  const sortedIds = person.meetingIds
    .filter((id) => allMeetings.has(id))
    .sort((a, b) => {
      const ma = allMeetings.get(a)!.created_at;
      const mb = allMeetings.get(b)!.created_at;
      return mb.localeCompare(ma);
    });

  for (const id of sortedIds) {
    lines.push(`- [Meeting #${id}](../Meetings/${id}.md)`);
  }

  lines.push("");
  return lines.join("\n");
}

function buildCompanyMarkdown(
  company: CompanyRecord,
  allMeetings: Map<number, Meeting>,
  peopleByDomain: Map<string, PersonRecord[]>,
  labels: Labels
): string {
  const lines: string[] = [];

  const companyEntry = labels.companies.get(company.domain);
  const companyTags = companyEntry ? [...companyEntry.relationships].sort() : [];

  const peopleInCompany = peopleByDomain.get(company.domain) ?? [];
  const aggregatedPersonRelationships = new Set<RelationshipTag>();
  for (const p of peopleInCompany) {
    const entry = labels.people.get(p.email.toLowerCase());
    if (entry) for (const r of entry.relationships) aggregatedPersonRelationships.add(r);
  }
  const personTagsSorted = [...aggregatedPersonRelationships].sort();

  lines.push("---");
  lines.push(`domain: "${company.domain}"`);
  lines.push(`meeting_count: ${company.meetingIds.length}`);
  lines.push(`contact_count: ${company.people.size}`);
  if (companyTags.length > 0) {
    lines.push("company_relationships:");
    for (const r of companyTags) lines.push(`  - "${r}"`);
  }
  if (personTagsSorted.length > 0) {
    lines.push("person_relationships:");
    for (const r of personTagsSorted) lines.push(`  - "${r}"`);
  }
  if (companyEntry?.notes) {
    lines.push(`notes: ${JSON.stringify(companyEntry.notes)}`);
  }
  lines.push("tags:");
  lines.push("  - company");
  for (const r of companyTags) lines.push(`  - "${r}"`);
  for (const r of personTagsSorted) lines.push(`  - "${r}"`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${company.domain}`);
  lines.push("");
  lines.push(
    `**Meetings:** ${company.meetingIds.length} | **Contacts:** ${company.people.size}`
  );
  if (companyTags.length > 0) {
    lines.push(`**Company relationships:** ${companyTags.join(", ")}`);
  }
  if (personTagsSorted.length > 0) {
    lines.push(`**People tags observed:** ${personTagsSorted.join(", ")}`);
  }
  if (companyEntry?.notes) {
    lines.push("");
    lines.push(`> ${companyEntry.notes}`);
  }
  lines.push("");
  lines.push("## Contacts");
  lines.push("");
  for (const name of [...company.people].sort()) {
    lines.push(`- [${name}](../People/${sanitizeFilename(name)}.md)`);
  }
  lines.push("");
  lines.push("## Meeting History");
  lines.push("");
  lines.push(
    "<!-- Opaque recording_id links; meeting titles and dates live only in the gitignored vault/Meetings/ files. -->"
  );
  lines.push("");

  const sortedIds = company.meetingIds
    .filter((id) => allMeetings.has(id))
    .sort((a, b) => {
      const ma = allMeetings.get(a)!.created_at;
      const mb = allMeetings.get(b)!.created_at;
      return mb.localeCompare(ma);
    });

  for (const id of sortedIds) {
    lines.push(`- [Meeting #${id}](../Meetings/${id}.md)`);
  }

  lines.push("");
  return lines.join("\n");
}

function main() {
  if (!existsSync(RAW_DIR)) {
    console.error("No data/raw/ directory. Run extract first: npm run extract");
    process.exit(1);
  }

  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("No JSON files in data/raw/. Run extract first.");
    process.exit(1);
  }

  console.log(`Transforming ${files.length} meetings...`);

  const labels = loadLabels();
  if (
    labels.people.size > 0 ||
    labels.meetings.size > 0 ||
    labels.companies.size > 0
  ) {
    console.log(
      `  Labels loaded: ${labels.people.size} people, ${labels.meetings.size} meetings, ${labels.companies.size} companies, ${labels.skippedPeople.size} skipped people, ${labels.skippedCompanies.size} skipped companies`
    );
  }

  const allMeetings = new Map<number, Meeting>();
  const people = new Map<string, PersonRecord>();
  const companies = new Map<string, CompanyRecord>();

  for (const file of files) {
    const meeting: Meeting = JSON.parse(
      readFileSync(join(RAW_DIR, file), "utf-8")
    );
    allMeetings.set(meeting.recording_id, meeting);

    for (const inv of meeting.calendar_invitees) {
      const name = inv.name || inv.email.split("@")[0];
      const key = inv.email.toLowerCase();
      const domain = extractDomain(inv.email);

      if (!people.has(key)) {
        people.set(key, { name, email: inv.email, domain, meetingIds: [] });
      }
      const person = people.get(key)!;
      if (!person.meetingIds.includes(meeting.recording_id)) {
        person.meetingIds.push(meeting.recording_id);
      }
      if (name && name !== person.name && inv.name) {
        person.name = inv.name;
      }

      if (domain) {
        if (!companies.has(domain)) {
          companies.set(domain, { domain, meetingIds: [], people: new Set() });
        }
        const company = companies.get(domain)!;
        company.people.add(name);
        if (!company.meetingIds.includes(meeting.recording_id)) {
          company.meetingIds.push(meeting.recording_id);
        }
      }
    }
  }

  let meetingCount = 0;
  for (const meeting of allMeetings.values()) {
    const md = buildMeetingMarkdown(meeting, labels);
    writeFileSync(join(MEETINGS_DIR, `${meeting.recording_id}.md`), md);
    meetingCount++;
  }
  console.log(`  ${meetingCount} meeting files written to vault/Meetings/`);

  const peopleByDomain = new Map<string, PersonRecord[]>();
  for (const p of people.values()) {
    if (!p.domain) continue;
    if (!peopleByDomain.has(p.domain)) peopleByDomain.set(p.domain, []);
    peopleByDomain.get(p.domain)!.push(p);
  }

  let personCount = 0;
  for (const person of people.values()) {
    const filename = sanitizeFilename(person.name);
    const md = buildPersonMarkdown(person, allMeetings, labels);
    writeFileSync(join(PEOPLE_DIR, `${filename}.md`), md);
    personCount++;
  }
  console.log(`  ${personCount} person files written to vault/People/`);

  let companyCount = 0;
  for (const company of companies.values()) {
    const filename = sanitizeFilename(company.domain);
    const md = buildCompanyMarkdown(company, allMeetings, peopleByDomain, labels);
    writeFileSync(join(COMPANIES_DIR, `${filename}.md`), md);
    companyCount++;
  }
  console.log(`  ${companyCount} company files written to vault/Companies/`);

  buildSqliteIndex(allMeetings, people, companies, labels);

  console.log("\nDone. Vault ready at vault/, SQLite at data/index.db");
}

function buildSqliteIndex(
  allMeetings: Map<number, Meeting>,
  people: Map<string, PersonRecord>,
  companies: Map<string, CompanyRecord>,
  labels: Labels
): void {
  const db: Database.Database = openDb();
  initSchema(db);
  clearAll(db);

  const insertMeeting = db.prepare(`
    INSERT INTO meetings (
      recording_id, title, meeting_title, date, created_at,
      recording_start, recording_end, duration_seconds,
      url, share_url, recorded_by_email, recorded_by_name,
      meeting_type, language, summary_markdown,
      has_transcript, transcript_entry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertParticipant = db.prepare(`
    INSERT INTO participants (email, name, domain, first_seen, last_seen, meeting_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMP = db.prepare(`
    INSERT OR IGNORE INTO meeting_participants (recording_id, email, is_organizer)
    VALUES (?, ?, ?)
  `);

  const insertCompany = db.prepare(`
    INSERT INTO companies (domain, first_seen, last_seen, meeting_count, contact_count)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMC = db.prepare(`
    INSERT OR IGNORE INTO meeting_companies (recording_id, domain) VALUES (?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO meetings_fts (recording_id, title, summary) VALUES (?, ?, ?)
  `);

  const meetingDateByEmail = new Map<
    string,
    { first: string; last: string; count: number }
  >();
  for (const m of allMeetings.values()) {
    for (const inv of m.calendar_invitees) {
      const email = inv.email.toLowerCase();
      const existing = meetingDateByEmail.get(email);
      if (!existing) {
        meetingDateByEmail.set(email, {
          first: m.created_at,
          last: m.created_at,
          count: 1,
        });
      } else {
        if (m.created_at < existing.first) existing.first = m.created_at;
        if (m.created_at > existing.last) existing.last = m.created_at;
        existing.count++;
      }
    }
  }

  const allEmails = new Set<string>();
  for (const m of allMeetings.values()) {
    for (const inv of m.calendar_invitees) {
      allEmails.add(inv.email.toLowerCase());
    }
  }

  const txn = db.transaction(() => {
    for (const email of allEmails) {
      const person = people.get(email);
      const stats = meetingDateByEmail.get(email) ?? {
        first: new Date().toISOString(),
        last: new Date().toISOString(),
        count: 0,
      };
      if (person) {
        insertParticipant.run(
          email,
          person.name,
          person.domain,
          stats.first,
          stats.last,
          stats.count
        );
      } else {
        insertParticipant.run(email, email.split("@")[0], null, stats.first, stats.last, stats.count);
      }
    }

    const companyDateStats = new Map<
      string,
      { first: string; last: string; count: number }
    >();
    for (const m of allMeetings.values()) {
      for (const inv of m.calendar_invitees) {
        const domain = inv.email.split("@")[1]?.toLowerCase();
        if (!domain || !companies.has(domain)) continue;
        const existing = companyDateStats.get(domain);
        if (!existing) {
          companyDateStats.set(domain, {
            first: m.created_at,
            last: m.created_at,
            count: 1,
          });
        } else {
          if (m.created_at < existing.first) existing.first = m.created_at;
          if (m.created_at > existing.last) existing.last = m.created_at;
          existing.count++;
        }
      }
    }

    for (const company of companies.values()) {
      const stats = companyDateStats.get(company.domain) ?? {
        first: new Date().toISOString(),
        last: new Date().toISOString(),
        count: 0,
      };
      insertCompany.run(
        company.domain,
        stats.first,
        stats.last,
        stats.count,
        company.people.size
      );
    }

    for (const m of allMeetings.values()) {
      const date = m.created_at.split("T")[0];
      let durationSeconds: number | null = null;
      if (m.recording_start_time && m.recording_end_time) {
        durationSeconds = Math.round(
          (new Date(m.recording_end_time).getTime() -
            new Date(m.recording_start_time).getTime()) /
            1000
        );
      }
      insertMeeting.run(
        m.recording_id,
        m.title,
        m.meeting_title,
        date,
        m.created_at,
        m.recording_start_time ?? null,
        m.recording_end_time ?? null,
        durationSeconds,
        m.url,
        m.share_url,
        m.recorded_by.email,
        m.recorded_by.name,
        m.calendar_invitees_domains_type ?? null,
        m.transcript_language,
        m.default_summary?.markdown_formatted ?? null,
        m.transcript && m.transcript.length > 0 ? 1 : 0,
        m.transcript?.length ?? 0
      );

      insertFts.run(
        m.recording_id,
        m.title,
        m.default_summary?.markdown_formatted ?? ""
      );

      const seenDomains = new Set<string>();
      for (const inv of m.calendar_invitees) {
        insertMP.run(
          m.recording_id,
          inv.email.toLowerCase(),
          inv.is_organizer ? 1 : 0
        );
        const domain = inv.email.split("@")[1]?.toLowerCase();
        if (domain && companies.has(domain) && !seenDomains.has(domain)) {
          seenDomains.add(domain);
          insertMC.run(m.recording_id, domain);
        }
      }
    }
  });

  txn();

  const { peopleApplied, meetingsApplied, companiesApplied, skipped } =
    applyLabelsToSqlite(db, labels);

  const autoInsert = db.prepare(
    "INSERT OR IGNORE INTO meeting_labels (recording_id, tag, notes) VALUES (?, ?, 'auto-derived')"
  );
  let autoCount = 0;
  const autoTxn = db.transaction(() => {
    for (const m of allMeetings.values()) {
      for (const tag of deriveCallTypes(m, labels)) {
        const r = autoInsert.run(m.recording_id, tag);
        if (r.changes > 0) autoCount++;
      }
    }
  });
  autoTxn();

  const meetingCount = db.prepare("SELECT COUNT(*) as c FROM meetings").get() as { c: number };
  const participantCount = db
    .prepare("SELECT COUNT(*) as c FROM participants")
    .get() as { c: number };
  const companyCount = db.prepare("SELECT COUNT(*) as c FROM companies").get() as {
    c: number;
  };
  console.log(
    `  SQLite indexed: ${meetingCount.c} meetings, ${participantCount.c} people, ${companyCount.c} companies`
  );
  if (
    peopleApplied > 0 ||
    meetingsApplied > 0 ||
    companiesApplied > 0 ||
    autoCount > 0
  ) {
    console.log(
      `  Labels applied: ${peopleApplied} person tags, ${meetingsApplied} authored meeting tags, ${autoCount} auto-derived meeting tags, ${companiesApplied} company tags`
    );
  }
  if (skipped.length > 0) {
    console.warn(`  Labels skipped (not in index): ${skipped.length}`);
    for (const s of skipped.slice(0, 5)) console.warn(`    - ${s}`);
    if (skipped.length > 5) console.warn(`    ...and ${skipped.length - 5} more`);
  }
  db.close();
}

main();
