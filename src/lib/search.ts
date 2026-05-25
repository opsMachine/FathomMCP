import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { embed } from "./embed-model.js";
import { openVectorDb, openOrCreateTable } from "./vectors.js";

export interface MeetingRow {
  recording_id: number;
  title: string;
  date: string;
  url: string;
  share_url: string;
  recorded_by_email: string;
  recorded_by_name: string;
  meeting_type: string | null;
  duration_seconds: number | null;
  has_transcript: number;
  summary_markdown: string | null;
}

export interface PersonRow {
  email: string;
  name: string;
  domain: string | null;
  first_seen: string;
  last_seen: string;
  meeting_count: number;
}

export interface CompanyRow {
  domain: string;
  first_seen: string;
  last_seen: string;
  meeting_count: number;
  contact_count: number;
}

export interface SemanticHit {
  id: string;
  recording_id: number;
  kind: string;
  text: string;
  start_timestamp: string;
  end_timestamp: string;
  speakers: string;
  meeting_date: string;
  meeting_title: string;
  participants: string;
  distance: number;
}

export interface SearchFilters {
  person?: string; // name or email substring
  company?: string; // domain
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
  type?: string;
  /**
   * Filter to meetings that include at least one participant carrying at
   * least one of the given relationship tags. OR within the array.
   */
  relationships?: string[];
  /**
   * Filter to meetings carrying at least one of the given call_type tags.
   * Includes both authored and auto-derived tags (internal, advisory).
   * OR within the array.
   */
  callTypes?: string[];
  /**
   * Filter to meetings whose participating companies carry at least one
   * of the given company-relationship tags (org-level vocab: client_org,
   * partner_org, advisor_to_org, vendor_org, etc.). OR within the array.
   * Use this when the question is org-shaped ("all my client orgs",
   * "every vendor relationship") rather than person-shaped.
   */
  companyRelationships?: string[];
  limit?: number;
}

export function listMeetings(
  db: Database.Database,
  filters: SearchFilters = {}
): MeetingRow[] {
  const where: string[] = ["1=1"];
  const params: Record<string, unknown> = {};

  if (filters.person) {
    where.push(`recording_id IN (
      SELECT mp.recording_id FROM meeting_participants mp
      JOIN participants p ON p.email = mp.email
      WHERE p.name LIKE @person COLLATE NOCASE OR p.email LIKE @person
    )`);
    params.person = `%${filters.person}%`;
  }

  if (filters.company) {
    where.push(`recording_id IN (
      SELECT recording_id FROM meeting_companies WHERE domain = @company
    )`);
    params.company = filters.company.toLowerCase();
  }

  if (filters.dateFrom) {
    where.push("date >= @dateFrom");
    params.dateFrom = filters.dateFrom;
  }

  if (filters.dateTo) {
    where.push("date <= @dateTo");
    params.dateTo = filters.dateTo;
  }

  if (filters.type) {
    where.push("meeting_type = @type");
    params.type = filters.type;
  }

  if (filters.relationships && filters.relationships.length > 0) {
    const placeholders = filters.relationships
      .map((_, i) => `@rel${i}`)
      .join(",");
    where.push(`recording_id IN (
      SELECT mp.recording_id FROM meeting_participants mp
      JOIN person_labels pl ON pl.email = mp.email
      WHERE pl.tag IN (${placeholders})
    )`);
    filters.relationships.forEach((tag, i) => {
      params[`rel${i}`] = tag;
    });
  }

  if (filters.callTypes && filters.callTypes.length > 0) {
    const placeholders = filters.callTypes
      .map((_, i) => `@ct${i}`)
      .join(",");
    where.push(`recording_id IN (
      SELECT recording_id FROM meeting_labels
      WHERE tag IN (${placeholders})
    )`);
    filters.callTypes.forEach((tag, i) => {
      params[`ct${i}`] = tag;
    });
  }

  if (filters.companyRelationships && filters.companyRelationships.length > 0) {
    const placeholders = filters.companyRelationships
      .map((_, i) => `@corel${i}`)
      .join(",");
    where.push(`recording_id IN (
      SELECT mc.recording_id FROM meeting_companies mc
      JOIN company_labels cl ON cl.domain = mc.domain
      WHERE cl.tag IN (${placeholders})
    )`);
    filters.companyRelationships.forEach((tag, i) => {
      params[`corel${i}`] = tag;
    });
  }

  const limit = filters.limit ?? 50;
  const sql = `
    SELECT recording_id, title, date, url, share_url,
           recorded_by_email, recorded_by_name, meeting_type,
           duration_seconds, has_transcript, summary_markdown
    FROM meetings
    WHERE ${where.join(" AND ")}
    ORDER BY date DESC
    LIMIT ${limit}
  `;
  return db.prepare(sql).all(params) as MeetingRow[];
}

export function getMeeting(
  db: Database.Database,
  recordingId: number
): (MeetingRow & { participants: PersonRow[]; companies: string[] }) | null {
  const meeting = db
    .prepare(
      `SELECT recording_id, title, date, url, share_url,
              recorded_by_email, recorded_by_name, meeting_type,
              duration_seconds, has_transcript, summary_markdown
       FROM meetings WHERE recording_id = ?`
    )
    .get(recordingId) as MeetingRow | undefined;
  if (!meeting) return null;

  const participants = db
    .prepare(
      `SELECT p.email, p.name, p.domain, p.first_seen, p.last_seen, p.meeting_count
       FROM meeting_participants mp
       JOIN participants p ON p.email = mp.email
       WHERE mp.recording_id = ?
       ORDER BY mp.is_organizer DESC, p.name`
    )
    .all(recordingId) as PersonRow[];

  const companies = db
    .prepare(`SELECT domain FROM meeting_companies WHERE recording_id = ?`)
    .all(recordingId) as { domain: string }[];

  return {
    ...meeting,
    participants,
    companies: companies.map((c) => c.domain),
  };
}

export function findPerson(
  db: Database.Database,
  query: string,
  limit = 10
): PersonRow[] {
  return db
    .prepare(
      `SELECT email, name, domain, first_seen, last_seen, meeting_count
       FROM participants
       WHERE name LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE
       ORDER BY meeting_count DESC
       LIMIT ?`
    )
    .all(`%${query}%`, `%${query}%`, limit) as PersonRow[];
}

export function findCompany(
  db: Database.Database,
  query: string,
  limit = 10
): CompanyRow[] {
  return db
    .prepare(
      `SELECT domain, first_seen, last_seen, meeting_count, contact_count
       FROM companies
       WHERE domain LIKE ? COLLATE NOCASE
       ORDER BY meeting_count DESC
       LIMIT ?`
    )
    .all(`%${query}%`, limit) as CompanyRow[];
}

export function keywordSearch(
  db: Database.Database,
  query: string,
  limit = 20
): Array<MeetingRow & { snippet: string }> {
  const rows = db
    .prepare(
      `SELECT m.recording_id, m.title, m.date, m.url, m.share_url,
              m.recorded_by_email, m.recorded_by_name, m.meeting_type,
              m.duration_seconds, m.has_transcript, m.summary_markdown,
              snippet(meetings_fts, 1, '**', '**', '...', 12) AS snippet
       FROM meetings_fts
       JOIN meetings m ON m.recording_id = meetings_fts.recording_id
       WHERE meetings_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit);
  return rows as Array<MeetingRow & { snippet: string }>;
}

export async function semanticSearch(
  query: string,
  options: {
    limit?: number;
    recordingIds?: number[];
    person?: string;
    company?: string;
    dateFrom?: string;
    dateTo?: string;
    relationships?: string[];
    callTypes?: string[];
    companyRelationships?: string[];
    /**
     * Force the returned result set to span at least N distinct meetings
     * (by `recording_id`). If the candidate pool cannot supply that many
     * distinct meetings, returns whatever is available and is honest about it.
     * Use to avoid the "10 chunks from the same meeting" single-slice failure
     * mode.
     */
    minDistinctMeetings?: number;
  } = {}
): Promise<SemanticHit[]> {
  const queryVec = await embed(query);
  const db = await openVectorDb();
  const table = await openOrCreateTable(db);
  const limit = options.limit ?? 10;
  const minDistinct = Math.max(0, options.minDistinctMeetings ?? 0);

  const needsScope =
    options.person ||
    options.company ||
    options.dateFrom ||
    options.dateTo ||
    (options.relationships && options.relationships.length > 0) ||
    (options.callTypes && options.callTypes.length > 0) ||
    (options.companyRelationships && options.companyRelationships.length > 0);

  let scopeIds = options.recordingIds;
  if (!scopeIds && needsScope) {
    const sqlite = openDb();
    const meetings = listMeetings(sqlite, {
      person: options.person,
      company: options.company,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      relationships: options.relationships,
      callTypes: options.callTypes,
      companyRelationships: options.companyRelationships,
      limit: 5000,
    });
    scopeIds = meetings.map((m) => m.recording_id);
    sqlite.close();
    if (scopeIds.length === 0) return [];
  }

  // Pull a wider pool when diversity is requested so the greedy diversifier
  // has real choice. Otherwise fall back to the previous 3x heuristic.
  const poolMultiplier = minDistinct > 0 ? Math.max(6, minDistinct * 3) : 3;
  let q = table.search(queryVec).limit(limit * poolMultiplier);
  if (scopeIds && scopeIds.length > 0) {
    const clause =
      scopeIds.length > 500
        ? undefined
        : `recording_id IN (${scopeIds.join(",")})`;
    if (clause) q = q.where(clause);
  }

  const results = await q.toArray();

  let filtered = results;
  if (scopeIds && scopeIds.length > 500) {
    const idSet = new Set(scopeIds);
    filtered = results.filter((r) => idSet.has(r.recording_id));
  }

  // Diversify: the lancedb `.search` already returns in ascending distance
  // (best match first). When minDistinct is requested, greedily fill the
  // first `minDistinct` slots with one chunk per distinct meeting, then
  // fill the rest with the remaining best hits regardless of meeting.
  let selected: typeof filtered;
  if (minDistinct > 0) {
    const firstSeen = new Map<number, typeof filtered[number]>();
    const rest: typeof filtered = [];
    for (const r of filtered) {
      if (!firstSeen.has(r.recording_id)) {
        firstSeen.set(r.recording_id, r);
      } else {
        rest.push(r);
      }
    }
    const distinctFirsts = Array.from(firstSeen.values());
    // Keep all distinct-meeting representatives up to `limit`, and back-fill
    // with the best remaining chunks (may repeat meetings).
    selected = [
      ...distinctFirsts.slice(0, limit),
      ...rest.slice(0, Math.max(0, limit - distinctFirsts.length)),
    ];
  } else {
    selected = filtered.slice(0, limit);
  }

  return selected.slice(0, limit).map((r) => ({
    id: r.id,
    recording_id: r.recording_id,
    kind: r.kind,
    text: r.text,
    start_timestamp: r.start_timestamp ?? "",
    end_timestamp: r.end_timestamp ?? "",
    speakers: r.speakers ?? "",
    meeting_date: r.meeting_date ?? "",
    meeting_title: r.meeting_title ?? "",
    participants: r.participants ?? "",
    distance: r._distance ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Timeline / status / verify primitives — support A1 (triangulation) and A3
// (temporal resolution) by giving the agent proper chronological views
// instead of a scattershot semantic result set.
// ---------------------------------------------------------------------------

export type EntityType = "person" | "company" | "project" | "topic";

export interface TimelineEntry {
  date: string;
  recording_id: number;
  meeting_title: string;
  url: string;
  participants: string[];
  snippet: string;
  speakers?: string;
  start_timestamp?: string;
  source: "participant" | "company" | "summary" | "transcript";
}

function truncate(text: string, max = 320): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "...";
}

function extractFirstSnippet(
  summaryMarkdown: string | null,
  entity: string,
  maxLen = 320
): string | null {
  if (!summaryMarkdown) return null;
  const lines = summaryMarkdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const needle = entity.toLowerCase();
  const hit = lines.find((l) => l.toLowerCase().includes(needle));
  if (hit) return truncate(hit, maxLen);
  // fall back to the first non-heading line
  const body = lines.find((l) => !l.startsWith("#"));
  return body ? truncate(body, maxLen) : null;
}

/**
 * Chronologically-ordered mentions of a person / company / project / topic
 * across meetings. Replaces the "call semantic_search three times and hope
 * the order makes sense" workaround.
 */
export async function getEntityTimeline(options: {
  entity: string;
  entityType: EntityType;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}): Promise<TimelineEntry[]> {
  const limit = options.limit ?? 30;
  const entity = options.entity.trim();
  if (!entity) return [];

  const sqlite = openDb();
  try {
    const mentions = new Map<number, TimelineEntry>();

    // Primary source: for person/company, use the relational filter.
    if (options.entityType === "person" || options.entityType === "company") {
      const filters: SearchFilters = {
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        limit: 500,
      };
      if (options.entityType === "person") filters.person = entity;
      else filters.company = entity;

      const rows = listMeetings(sqlite, filters);
      for (const m of rows) {
        const snippet =
          extractFirstSnippet(m.summary_markdown, entity) ??
          `(no summary snippet; see meeting ${m.recording_id})`;
        mentions.set(m.recording_id, {
          date: m.date,
          recording_id: m.recording_id,
          meeting_title: m.title,
          url: m.url,
          participants: [],
          snippet,
          source:
            options.entityType === "person" ? "participant" : "company",
        });
      }
    }

    // For project/topic (or to enrich person/company with in-meeting text),
    // also run keyword + semantic searches.
    const ftsQuery = entity.includes(" ") ? `"${entity}"` : entity;
    try {
      const ftsRows = keywordSearch(sqlite, ftsQuery, 50);
      for (const r of ftsRows) {
        if (options.dateFrom && r.date < options.dateFrom) continue;
        if (options.dateTo && r.date > options.dateTo) continue;
        const existing = mentions.get(r.recording_id);
        const snippet = truncate(
          r.snippet?.replace(/\*\*/g, "") ||
            extractFirstSnippet(r.summary_markdown, entity) ||
            r.title,
          320
        );
        if (!existing) {
          mentions.set(r.recording_id, {
            date: r.date,
            recording_id: r.recording_id,
            meeting_title: r.title,
            url: r.url,
            participants: [],
            snippet,
            source: "summary",
          });
        } else if (
          existing.source === "participant" ||
          existing.source === "company"
        ) {
          // Upgrade the snippet from "no summary snippet" placeholder to
          // the real summary FTS match.
          if (existing.snippet.startsWith("(no summary snippet")) {
            existing.snippet = snippet;
            existing.source = "summary";
          }
        }
      }
    } catch {
      // FTS5 may reject some queries — ignore and fall through to semantic.
    }

    const hits = await semanticSearch(entity, {
      limit: Math.max(limit * 2, 30),
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      minDistinctMeetings: limit,
    });
    for (const h of hits) {
      const existing = mentions.get(h.recording_id);
      if (!existing) {
        mentions.set(h.recording_id, {
          date: h.meeting_date,
          recording_id: h.recording_id,
          meeting_title: h.meeting_title,
          url: "",
          participants: h.participants
            ? h.participants.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          snippet: truncate(h.text),
          speakers: h.speakers || undefined,
          start_timestamp: h.start_timestamp || undefined,
          source: "transcript",
        });
      } else {
        // Enrich with speaker/timestamp where we didn't have it, and
        // prefer a transcript snippet over a "no summary" placeholder.
        if (!existing.speakers && h.speakers) existing.speakers = h.speakers;
        if (!existing.start_timestamp && h.start_timestamp)
          existing.start_timestamp = h.start_timestamp;
        if (
          existing.snippet.startsWith("(no summary snippet") ||
          existing.source === "participant" ||
          existing.source === "company"
        ) {
          existing.snippet = truncate(h.text);
          existing.source = "transcript";
        }
      }
    }

    // Backfill missing metadata (url / participants) from the meetings table
    // for any mention we only learned about through the vector DB.
    const incomplete = Array.from(mentions.values()).filter(
      (m) => !m.url || m.participants.length === 0
    );
    if (incomplete.length > 0) {
      const ids = incomplete.map((m) => m.recording_id);
      const placeholders = ids.map(() => "?").join(",");
      const metaRows = sqlite
        .prepare(
          `SELECT m.recording_id, m.url, m.date,
                  GROUP_CONCAT(p.name, ', ') AS participants
           FROM meetings m
           LEFT JOIN meeting_participants mp ON mp.recording_id = m.recording_id
           LEFT JOIN participants p ON p.email = mp.email
           WHERE m.recording_id IN (${placeholders})
           GROUP BY m.recording_id`
        )
        .all(...ids) as Array<{
        recording_id: number;
        url: string;
        date: string;
        participants: string | null;
      }>;
      for (const r of metaRows) {
        const entry = mentions.get(r.recording_id);
        if (!entry) continue;
        if (!entry.url) entry.url = r.url;
        if (entry.participants.length === 0 && r.participants) {
          entry.participants = r.participants
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (!entry.date) entry.date = r.date;
      }
    }

    return Array.from(mentions.values())
      .filter((m) => !!m.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit); // keep the most recent `limit` mentions
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// get_project_status — infers the latest known state of a named project
// from signal words in the most recent mentions. Heuristic; the output is
// explicit about confidence and always returns the underlying evidence so
// the caller can override.
// ---------------------------------------------------------------------------

export type ProjectStatus =
  | "active"
  | "paused"
  | "canceled"
  | "completed"
  | "unknown";

export interface StatusEvidence {
  date: string;
  recording_id: number;
  meeting_title: string;
  url: string;
  snippet: string;
  inferred_status: ProjectStatus;
  matched_terms: string[];
}

export interface ProjectStatusResult {
  project: string;
  status: ProjectStatus;
  confidence: "high" | "medium" | "low" | "none";
  as_of?: string;
  confirmed_in?: StatusEvidence;
  history: StatusEvidence[];
  note: string;
}

const STATUS_PATTERNS: Array<{
  status: Exclude<ProjectStatus, "unknown">;
  terms: RegExp[];
}> = [
  {
    status: "canceled",
    terms: [
      /\bcancell?ed\b/i,
      /\bkill(ed|ing)?\b/i,
      /\bshelv(ed|ing)\b/i,
      /\bscrapp?(ed|ing)\b/i,
      /\bpull(ed|ing) the plug\b/i,
      /\bwalk(ed|ing) away\b/i,
      /\bnot moving forward\b/i,
      /\bno(t)? going to happen\b/i,
      /\bdead\b/i,
      /\bdropped\b/i,
    ],
  },
  {
    status: "paused",
    terms: [
      /\bpaus(ed|ing|e)\b/i,
      /\bon hold\b/i,
      /\bon ice\b/i,
      /\bparked\b/i,
      /\bbackburner(ed)?\b/i,
      /\bdeferr(ed|ing)\b/i,
      /\bpostpon(ed|ing|e)\b/i,
      /\bwait(ing)? (on|for)\b/i,
    ],
  },
  {
    status: "completed",
    terms: [
      /\bcomplet(ed|e)\b/i,
      /\bfinish(ed|ing)\b/i,
      /\bwrapp?(ed|ing) up\b/i,
      /\blaunch(ed|ing)\b/i,
      /\bship(ped|ping)\b/i,
      /\bdeliver(ed|ing)\b/i,
      /\bdone\b/i,
      /\bclos(ed|ing) (out|won)\b/i,
    ],
  },
  {
    status: "active",
    terms: [
      /\bkick(ed|ing) off\b/i,
      /\bkickoff\b/i,
      /\bstart(ed|ing)\b/i,
      /\bin progress\b/i,
      /\bongoing\b/i,
      /\bmoving forward\b/i,
      /\bgreen ?light(ed)?\b/i,
      /\bsigned( the)?( contract)?\b/i,
      /\bwork(ing)? on\b/i,
    ],
  },
];

function classifySnippet(snippet: string): {
  status: ProjectStatus;
  matched: string[];
} {
  const matched: string[] = [];
  let hit: Exclude<ProjectStatus, "unknown"> | null = null;
  for (const group of STATUS_PATTERNS) {
    for (const re of group.terms) {
      const m = snippet.match(re);
      if (m) {
        matched.push(m[0]);
        if (!hit) hit = group.status;
      }
    }
    if (hit) break; // first group (canceled) wins over later ones when both match
  }
  return { status: hit ?? "unknown", matched };
}

export async function getProjectStatus(options: {
  project: string;
  asOf?: string;
}): Promise<ProjectStatusResult> {
  const { project, asOf } = options;
  const timeline = await getEntityTimeline({
    entity: project,
    entityType: "project",
    dateTo: asOf,
    limit: 30,
  });

  if (timeline.length === 0) {
    return {
      project,
      status: "unknown",
      confidence: "none",
      as_of: asOf,
      history: [],
      note: `No mentions of "${project}" found${asOf ? ` up to ${asOf}` : ""}.`,
    };
  }

  const history: StatusEvidence[] = timeline.map((t) => {
    const { status, matched } = classifySnippet(t.snippet);
    return {
      date: t.date,
      recording_id: t.recording_id,
      meeting_title: t.meeting_title,
      url: t.url,
      snippet: t.snippet,
      inferred_status: status,
      matched_terms: matched,
    };
  });

  // Latest mention with an explicit status signal wins.
  const statusful = [...history].reverse().find(
    (h) => h.inferred_status !== "unknown"
  );

  if (!statusful) {
    const mostRecent = history[history.length - 1];
    return {
      project,
      status: "unknown",
      confidence: "low",
      as_of: asOf,
      confirmed_in: mostRecent,
      history,
      note: `Found ${history.length} mention(s) but no explicit status signal (canceled / paused / completed / active). The most recent mention is on ${mostRecent.date} — read it directly to confirm status.`,
    };
  }

  // Confidence heuristic: `matched_terms.length` and whether the most recent
  // mention (not merely the most recent _status_ signal) was the statusful one.
  const isMostRecent =
    statusful.recording_id === history[history.length - 1].recording_id;
  const confidence: ProjectStatusResult["confidence"] =
    isMostRecent && statusful.matched_terms.length >= 1
      ? statusful.matched_terms.length >= 2
        ? "high"
        : "medium"
      : "low";

  return {
    project,
    status: statusful.inferred_status,
    confidence,
    as_of: asOf,
    confirmed_in: statusful,
    history,
    note: isMostRecent
      ? `Status inferred from the most recent mention (${statusful.date}) using keyword heuristics. Verify by reading the meeting directly.`
      : `The most recent status signal is from ${statusful.date}, but there are newer mentions (up to ${history[history.length - 1].date}) without a clear status signal. Read the newer meetings to confirm the project is still in this state.`,
  };
}

// ---------------------------------------------------------------------------
// verify_claim — return supporting / contradicting / unclear evidence for
// a user-stated claim. The classifier is a negation-proximity heuristic;
// the tool is explicit that the calling LLM should re-read the buckets
// before asserting.
// ---------------------------------------------------------------------------

const NEGATION_MARKERS =
  /\b(not|no|never|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|can'?t|cannot|isn'?t|aren'?t|wasn'?t|weren'?t|refus(e|ed|ing)|disagree|against|instead of|rather than|opposite|contrary|hate|avoid)\b/i;

export interface ClaimEvidence {
  recording_id: number;
  meeting_title: string;
  meeting_date: string;
  speakers: string;
  text: string;
  url: string;
  distance: number;
  matched_negations: string[];
}

export interface VerifyClaimResult {
  claim: string;
  counter_claim?: string;
  supporting: ClaimEvidence[];
  contradicting: ClaimEvidence[];
  unclear: ClaimEvidence[];
  method: string;
  note: string;
}

function enrichWithUrl(
  sqlite: Database.Database,
  recordingIds: number[]
): Map<number, string> {
  if (recordingIds.length === 0) return new Map();
  const placeholders = recordingIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT recording_id, url FROM meetings WHERE recording_id IN (${placeholders})`
    )
    .all(...recordingIds) as Array<{ recording_id: number; url: string }>;
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.recording_id, r.url);
  return m;
}

export async function verifyClaim(options: {
  claim: string;
  counterClaim?: string;
  dateFrom?: string;
  dateTo?: string;
  person?: string;
  company?: string;
  limit?: number;
}): Promise<VerifyClaimResult> {
  const { claim, counterClaim } = options;
  const perBucket = options.limit ?? 5;

  const supportingHits = await semanticSearch(claim, {
    limit: perBucket * 3,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    person: options.person,
    company: options.company,
    minDistinctMeetings: perBucket,
  });

  const contradictingHits = counterClaim
    ? await semanticSearch(counterClaim, {
        limit: perBucket * 3,
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        person: options.person,
        company: options.company,
        minDistinctMeetings: perBucket,
      })
    : [];

  const sqlite = openDb();
  try {
    const allIds = new Set<number>();
    for (const h of supportingHits) allIds.add(h.recording_id);
    for (const h of contradictingHits) allIds.add(h.recording_id);
    const urlMap = enrichWithUrl(sqlite, Array.from(allIds));

    const toEvidence = (h: SemanticHit): ClaimEvidence => {
      const negations: string[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(NEGATION_MARKERS.source, "gi");
      while ((m = re.exec(h.text)) !== null) negations.push(m[0]);
      return {
        recording_id: h.recording_id,
        meeting_title: h.meeting_title,
        meeting_date: h.meeting_date,
        speakers: h.speakers,
        text: truncate(h.text, 500),
        url: urlMap.get(h.recording_id) ?? "",
        distance: Number(h.distance.toFixed(4)),
        matched_negations: negations,
      };
    };

    const supportingEv = supportingHits.map(toEvidence);
    const contradictingEv = contradictingHits.map(toEvidence);

    // Apply the negation heuristic to the `supporting` bucket: items whose
    // text contains negation markers are demoted to `contradicting` (when no
    // counter_claim is provided) or `unclear` (when a counter_claim already
    // fills contradicting).
    const supporting: ClaimEvidence[] = [];
    const heuristicContradicting: ClaimEvidence[] = [];
    const unclear: ClaimEvidence[] = [];

    for (const ev of supportingEv) {
      if (ev.distance > 1.2) {
        unclear.push(ev);
      } else if (ev.matched_negations.length > 0) {
        if (counterClaim) unclear.push(ev);
        else heuristicContradicting.push(ev);
      } else {
        supporting.push(ev);
      }
    }

    const method = counterClaim
      ? "Two-query retrieval: the claim and its counter-claim were both searched against the corpus; each top hit is returned with its semantic distance and detected negation markers. The caller (LLM) should re-read each quote before asserting."
      : "Single-query retrieval with a negation-proximity heuristic. Hits whose text contains negation markers ('not', 'never', 'don't', 'refuse', etc.) are demoted to 'contradicting'. This heuristic produces false positives (negation about an unrelated clause) and false negatives (contradiction expressed without explicit negation); the caller should re-read each quote before asserting.";

    return {
      claim,
      counter_claim: counterClaim,
      supporting: supporting.slice(0, perBucket),
      contradicting: (counterClaim ? contradictingEv : heuristicContradicting).slice(
        0,
        perBucket
      ),
      unclear: unclear.slice(0, perBucket),
      method,
      note:
        supporting.length + (counterClaim ? contradictingEv.length : heuristicContradicting.length) + unclear.length === 0
          ? "No evidence found. The claim is neither supported nor contradicted by the indexed meetings — do not assert it."
          : "Evidence returned. Re-read each quote with speaker and date before synthesizing. If the supporting bucket is empty or much smaller than unclear, the claim is not well-grounded.",
    };
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// get_transcript — retrieve all indexed transcript chunks for a meeting,
// ordered by timestamp, with an optional `speaker` substring filter.
//
// Note on B5 dependency: many chunks have `speakers: "Unknown"` upstream.
// The speaker filter still works — it just returns few/no matches for real
// names until attribution is improved. This is honest behavior.
// ---------------------------------------------------------------------------

export interface TranscriptChunk {
  chunk_index: number;
  kind: string;
  text: string;
  start_timestamp: string;
  end_timestamp: string;
  speakers: string;
}

function timestampToSeconds(ts: string): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  // Expect HH:MM:SS or MM:SS; fall back to numeric parse.
  const parts = ts.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return Number.POSITIVE_INFINITY;
  if (parts.length === 3)
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? Number.POSITIVE_INFINITY;
}

export async function getTranscriptChunks(options: {
  recordingId: number;
  speaker?: string;
  includeSummary?: boolean;
}): Promise<TranscriptChunk[]> {
  const db = await openVectorDb();
  const table = await openOrCreateTable(db);

  // LanceDB supports predicate-based filters via .where(). We cannot easily
  // do "only chunks from this recording_id" without a vector query, so we
  // pull all matching rows via SQL-like filter on the dataset.
  const rows = (await table
    .query()
    .where(`recording_id = ${options.recordingId}`)
    .limit(2000)
    .toArray()) as Array<{
    chunk_index: number;
    kind: string;
    text: string;
    start_timestamp: string | null;
    end_timestamp: string | null;
    speakers: string | null;
  }>;

  let filtered = rows;
  if (!options.includeSummary) {
    filtered = filtered.filter((r) => r.kind !== "summary");
  }

  if (options.speaker) {
    const needle = options.speaker.toLowerCase();
    filtered = filtered.filter((r) =>
      (r.speakers ?? "").toLowerCase().includes(needle)
    );
  }

  return filtered
    .map((r) => ({
      chunk_index: r.chunk_index,
      kind: r.kind,
      text: r.text,
      start_timestamp: r.start_timestamp ?? "",
      end_timestamp: r.end_timestamp ?? "",
      speakers: r.speakers ?? "",
    }))
    .sort((a, b) => {
      const av = timestampToSeconds(a.start_timestamp);
      const bv = timestampToSeconds(b.start_timestamp);
      if (av !== bv) return av - bv;
      return a.chunk_index - b.chunk_index;
    });
}
