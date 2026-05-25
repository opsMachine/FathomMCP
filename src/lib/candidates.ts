import type Database from "better-sqlite3";
import type { Labels } from "./labels.js";

/**
 * Candidate builders for human-in-the-loop labeling.
 *
 * Pure SQLite reads plus an in-memory labels map. Builders return unlabeled
 * subjects (people or meetings) packaged with the context a reviewer needs
 * to decide which tag(s) apply: basic info, most-recent summaries (capped),
 * and -- for people -- what relationships their co-attendees already carry.
 *
 * Nothing here writes back; the dossier writers in src/prep-people.ts and
 * src/prep-calls.ts consume these payloads and emit markdown.
 */

export interface PersonCandidateMeeting {
  recording_id: number;
  date: string;
  title: string;
  summary: string | null;
  meeting_type: string | null;
}

export interface PersonCandidate {
  email: string;
  name: string;
  domain: string | null;
  is_external: boolean;
  meeting_count: number;
  first_seen: string;
  last_seen: string;
  meetings: PersonCandidateMeeting[];
  omitted_meeting_count: number;
  co_attendees_known: Array<{
    email: string;
    name: string;
    relationships: string[];
  }>;
}

export interface MeetingCandidateParticipant {
  email: string;
  name: string;
  is_external: boolean;
  known_relationships: string[];
}

export interface MeetingCandidate {
  recording_id: number;
  date: string;
  title: string;
  duration_seconds: number | null;
  meeting_type: string | null;
  participants: MeetingCandidateParticipant[];
  summary: string | null;
}

export interface CandidateOptions {
  limit?: number;
  meetingsPerPerson?: number;
  maxSummaryChars?: number;
  myEmail?: string;
}

const DEFAULT_MEETINGS_PER_PERSON = 8;
const DEFAULT_MAX_SUMMARY_CHARS = 1500;

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "... [truncated]";
}

function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Return the organizer's email from the most recent meeting, if any. Used
 * to define "external" when no myEmail is passed.
 */
function inferMyDomain(db: Database.Database, explicit?: string): string | null {
  if (explicit) {
    return domainOf(explicit);
  }
  const row = db
    .prepare(
      "SELECT recorded_by_email FROM meetings ORDER BY date DESC LIMIT 1"
    )
    .get() as { recorded_by_email: string } | undefined;
  if (!row) return null;
  return domainOf(row.recorded_by_email);
}

/**
 * Build per-person candidates for everyone in `participants` whose email
 * is not currently in labels.people (regardless of notes-only entries).
 *
 * Sorted by meeting_count descending so the reviewer sees strongest signals
 * first and can cut off cleanly with --limit.
 */
export function buildPersonCandidates(
  db: Database.Database,
  labels: Labels,
  excludeEmails: Set<string> = new Set(),
  options: CandidateOptions = {}
): PersonCandidate[] {
  const myDomain = inferMyDomain(db, options.myEmail);
  const meetingsCap = options.meetingsPerPerson ?? DEFAULT_MEETINGS_PER_PERSON;
  const summaryCap = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const limit = options.limit;

  const rows = db
    .prepare(
      `SELECT email, name, domain, first_seen, last_seen, meeting_count
       FROM participants
       ORDER BY meeting_count DESC, last_seen DESC`
    )
    .all() as Array<{
    email: string;
    name: string;
    domain: string | null;
    first_seen: string;
    last_seen: string;
    meeting_count: number;
  }>;

  const meetingsForEmail = db.prepare(
    `SELECT m.recording_id, m.title, m.date, m.summary_markdown, m.meeting_type
     FROM meeting_participants mp
     JOIN meetings m ON m.recording_id = mp.recording_id
     WHERE mp.email = ?
     ORDER BY m.date DESC`
  );

  const coAttendees = db.prepare(
    `SELECT DISTINCT p.email, p.name
     FROM meeting_participants mp
     JOIN meeting_participants mp2 ON mp.recording_id = mp2.recording_id
     JOIN participants p ON p.email = mp2.email
     WHERE mp.email = ? AND mp2.email != ?`
  );

  const labelsFor = db.prepare(
    `SELECT tag FROM person_labels WHERE email = ? ORDER BY tag`
  );

  const candidates: PersonCandidate[] = [];

  for (const row of rows) {
    const email = row.email.toLowerCase();
    if (labels.people.has(email)) continue;
    if (labels.skippedPeople.has(email)) continue;
    if (excludeEmails.has(email)) continue;

    const meetingsRaw = meetingsForEmail.all(email) as Array<{
      recording_id: number;
      title: string;
      date: string;
      summary_markdown: string | null;
      meeting_type: string | null;
    }>;
    if (meetingsRaw.length === 0) continue;

    const meetings: PersonCandidateMeeting[] = meetingsRaw
      .slice(0, meetingsCap)
      .map((m) => ({
        recording_id: m.recording_id,
        date: m.date,
        title: m.title,
        summary: truncate(m.summary_markdown, summaryCap),
        meeting_type: m.meeting_type,
      }));

    const omitted = Math.max(0, meetingsRaw.length - meetingsCap);

    const coRows = coAttendees.all(email, email) as Array<{
      email: string;
      name: string;
    }>;
    const coAttendeesKnown: Array<{
      email: string;
      name: string;
      relationships: string[];
    }> = [];
    for (const co of coRows) {
      const tags = (labelsFor.all(co.email.toLowerCase()) as { tag: string }[])
        .map((t) => t.tag);
      if (tags.length > 0) {
        coAttendeesKnown.push({
          email: co.email,
          name: co.name,
          relationships: tags,
        });
      }
    }

    const domain = row.domain;
    const isExternal = myDomain != null && domain != null && domain !== myDomain;

    candidates.push({
      email: row.email,
      name: row.name,
      domain,
      is_external: isExternal,
      meeting_count: row.meeting_count,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      meetings,
      omitted_meeting_count: omitted,
      co_attendees_known: coAttendeesKnown,
    });

    if (limit && candidates.length >= limit) break;
  }

  return candidates;
}

/**
 * Build per-meeting candidates for every recording_id not labeled in
 * labels.meetings. Internal-only meetings (no participant with a domain
 * different from the recorder's) are skipped entirely since the `internal`
 * tag is auto-derived at transform time.
 *
 * Externality is detected from participant domains rather than the raw
 * `meeting_type` field (which is frequently null in the Fathom payload).
 *
 * Sorted by date descending.
 */
export function buildMeetingCandidates(
  db: Database.Database,
  labels: Labels,
  excludeIds: Set<number> = new Set(),
  options: CandidateOptions = {}
): MeetingCandidate[] {
  const myDomain = inferMyDomain(db, options.myEmail);
  const summaryCap = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const limit = options.limit;

  const rows = db
    .prepare(
      `SELECT recording_id, title, date, duration_seconds, meeting_type, summary_markdown
       FROM meetings
       ORDER BY date DESC`
    )
    .all() as Array<{
    recording_id: number;
    title: string;
    date: string;
    duration_seconds: number | null;
    meeting_type: string | null;
    summary_markdown: string | null;
  }>;

  const participantsFor = db.prepare(
    `SELECT p.email, p.name, p.domain
     FROM meeting_participants mp
     JOIN participants p ON p.email = mp.email
     WHERE mp.recording_id = ?
     ORDER BY mp.is_organizer DESC, p.name`
  );

  const labelsFor = db.prepare(
    `SELECT tag FROM person_labels WHERE email = ? ORDER BY tag`
  );

  const candidates: MeetingCandidate[] = [];

  for (const row of rows) {
    if (labels.meetings.has(row.recording_id)) continue;
    if (excludeIds.has(row.recording_id)) continue;

    const parts = participantsFor.all(row.recording_id) as Array<{
      email: string;
      name: string;
      domain: string | null;
    }>;

    const participants: MeetingCandidateParticipant[] = parts.map((p) => {
      const tags = (labelsFor.all(p.email.toLowerCase()) as { tag: string }[])
        .map((t) => t.tag);
      const isExternal =
        myDomain != null && p.domain != null && p.domain !== myDomain;
      return {
        email: p.email,
        name: p.name,
        is_external: isExternal,
        known_relationships: tags,
      };
    });

    const hasExternal = participants.some((p) => p.is_external);
    if (!hasExternal) continue;

    candidates.push({
      recording_id: row.recording_id,
      date: row.date,
      title: row.title,
      duration_seconds: row.duration_seconds,
      meeting_type: row.meeting_type,
      participants,
      summary: truncate(row.summary_markdown, summaryCap),
    });

    if (limit && candidates.length >= limit) break;
  }

  return candidates;
}

/**
 * Count total unlabeled candidates (for reporting "X of Y remaining" in
 * dossier summaries). Cheaper than building full payloads for everyone.
 */
export function countUnlabeledPeople(
  db: Database.Database,
  labels: Labels,
  excludeEmails: Set<string> = new Set()
): number {
  const rows = db.prepare(`SELECT email FROM participants`).all() as {
    email: string;
  }[];
  let n = 0;
  for (const r of rows) {
    const e = r.email.toLowerCase();
    if (labels.people.has(e) || labels.skippedPeople.has(e) || excludeEmails.has(e))
      continue;
    n++;
  }
  return n;
}

export function countUnlabeledMeetings(
  db: Database.Database,
  labels: Labels,
  excludeIds: Set<number> = new Set(),
  myEmail?: string
): number {
  const myDomain = inferMyDomain(db, myEmail);
  const rows = db
    .prepare(`SELECT recording_id FROM meetings`)
    .all() as { recording_id: number }[];
  const hasExternal = db.prepare(
    `SELECT 1 FROM meeting_participants mp
     JOIN participants p ON p.email = mp.email
     WHERE mp.recording_id = ? AND p.domain IS NOT NULL AND p.domain != ?
     LIMIT 1`
  );
  let n = 0;
  for (const r of rows) {
    if (labels.meetings.has(r.recording_id)) continue;
    if (excludeIds.has(r.recording_id)) continue;
    if (myDomain && !hasExternal.get(r.recording_id, myDomain)) continue;
    n++;
  }
  return n;
}

export interface CompanyCandidatePerson {
  email: string;
  name: string;
  meeting_count: number;
  relationships: string[];
}

export interface CompanyCandidateMeeting {
  recording_id: number;
  date: string;
  title: string;
  summary: string | null;
}

export interface CompanyCandidate {
  domain: string;
  is_self: boolean;
  meeting_count: number;
  contact_count: number;
  first_seen: string;
  last_seen: string;
  people: CompanyCandidatePerson[];
  omitted_people_count: number;
  representative_meetings: CompanyCandidateMeeting[];
  omitted_meeting_count: number;
}

export interface CompanyCandidateOptions extends CandidateOptions {
  peoplePerCompany?: number;
  meetingsPerCompany?: number;
}

const DEFAULT_PEOPLE_PER_COMPANY = 10;
const DEFAULT_MEETINGS_PER_COMPANY = 5;

/**
 * Build per-company candidates for every domain in `companies` whose domain
 * is not currently in labels.companies.
 *
 * For each company we surface:
 *   - meeting_count / contact_count / first + last seen
 *   - is_self (domain matches myDomain)
 *   - top N people at this domain with their known relationships (strong prior)
 *   - most-recent M meeting titles + summaries (signal of engagement scope)
 *
 * Sorted by meeting_count desc so the reviewer sees strongest signals first
 * and can cut off cleanly with --limit.
 */
export function buildCompanyCandidates(
  db: Database.Database,
  labels: Labels,
  excludeDomains: Set<string> = new Set(),
  options: CompanyCandidateOptions = {}
): CompanyCandidate[] {
  const myDomain = inferMyDomain(db, options.myEmail);
  const peopleCap = options.peoplePerCompany ?? DEFAULT_PEOPLE_PER_COMPANY;
  const meetingsCap = options.meetingsPerCompany ?? DEFAULT_MEETINGS_PER_COMPANY;
  const summaryCap = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const limit = options.limit;

  const rows = db
    .prepare(
      `SELECT domain, first_seen, last_seen, meeting_count, contact_count
       FROM companies
       WHERE meeting_count > 0
       ORDER BY meeting_count DESC, last_seen DESC`
    )
    .all() as Array<{
    domain: string;
    first_seen: string;
    last_seen: string;
    meeting_count: number;
    contact_count: number;
  }>;

  const peopleForDomain = db.prepare(
    `SELECT email, name, meeting_count
     FROM participants
     WHERE domain = ?
     ORDER BY meeting_count DESC, last_seen DESC`
  );

  const labelsFor = db.prepare(
    `SELECT tag FROM person_labels WHERE email = ? ORDER BY tag`
  );

  const meetingsForDomain = db.prepare(
    `SELECT DISTINCT m.recording_id, m.title, m.date, m.summary_markdown
     FROM meeting_companies mc
     JOIN meetings m ON m.recording_id = mc.recording_id
     WHERE mc.domain = ?
     ORDER BY m.date DESC`
  );

  const candidates: CompanyCandidate[] = [];

  for (const row of rows) {
    const domain = row.domain.toLowerCase();
    if (labels.companies.has(domain)) continue;
    if (labels.skippedCompanies.has(domain)) continue;
    if (excludeDomains.has(domain)) continue;

    const peopleRaw = peopleForDomain.all(domain) as Array<{
      email: string;
      name: string;
      meeting_count: number;
    }>;

    const people: CompanyCandidatePerson[] = peopleRaw
      .slice(0, peopleCap)
      .map((p) => {
        const tags = (
          labelsFor.all(p.email.toLowerCase()) as { tag: string }[]
        ).map((t) => t.tag);
        return {
          email: p.email,
          name: p.name,
          meeting_count: p.meeting_count,
          relationships: tags,
        };
      });
    const omittedPeople = Math.max(0, peopleRaw.length - peopleCap);

    const meetingsRaw = meetingsForDomain.all(domain) as Array<{
      recording_id: number;
      title: string;
      date: string;
      summary_markdown: string | null;
    }>;
    const representative_meetings: CompanyCandidateMeeting[] = meetingsRaw
      .slice(0, meetingsCap)
      .map((m) => ({
        recording_id: m.recording_id,
        date: m.date,
        title: m.title,
        summary: truncate(m.summary_markdown, summaryCap),
      }));
    const omittedMeetings = Math.max(0, meetingsRaw.length - meetingsCap);

    candidates.push({
      domain,
      is_self: myDomain != null && domain === myDomain,
      meeting_count: row.meeting_count,
      contact_count: row.contact_count,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      people,
      omitted_people_count: omittedPeople,
      representative_meetings,
      omitted_meeting_count: omittedMeetings,
    });

    if (limit && candidates.length >= limit) break;
  }

  return candidates;
}

export function countUnlabeledCompanies(
  db: Database.Database,
  labels: Labels,
  excludeDomains: Set<string> = new Set()
): number {
  const rows = db
    .prepare(`SELECT domain FROM companies WHERE meeting_count > 0`)
    .all() as { domain: string }[];
  let n = 0;
  for (const r of rows) {
    const d = r.domain.toLowerCase();
    if (
      !labels.companies.has(d) &&
      !labels.skippedCompanies.has(d) &&
      !excludeDomains.has(d)
    )
      n++;
  }
  return n;
}
