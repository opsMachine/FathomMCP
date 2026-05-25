import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { LABELS_PATH } from "./paths.js";

export { LABELS_PATH };

/**
 * Canonical tag vocabularies.
 *
 * These arrays are the single source of truth for valid tags. The YAML file
 * at config/labels.yml is validated against them on load; unknown tags are
 * warned and skipped, never persisted.
 *
 * Auto-derived tags (`advisory`, `internal`) are computed at query time from
 * participants / meeting_type rather than authored in the YAML, and so do
 * not appear in RELATIONSHIP_TAGS / CALL_TYPE_TAGS.
 */
export const RELATIONSHIP_TAGS = [
  "advisor_to",
  "advisor",
  "prospective_advisor",
  "client",
  "former_client",
  "prospective_client",
  "partner",
  "former_partner",
  "prospective_partner",
  "former_prospective_partner",
  "candidate",
  "vendor",
  "team",
  "colleague",
  "friend",
  "family",
  "connection",
] as const;

export type RelationshipTag = (typeof RELATIONSHIP_TAGS)[number];

export const RELATIONSHIP_DESCRIPTIONS: Record<RelationshipTag, string> = {
  advisor_to: "I advise them / their company",
  advisor: "They advise me (mentor)",
  prospective_advisor: "Exploring them as a potential advisor to me",
  client: "Active paid client",
  former_client: "Previously a paid client",
  prospective_client: "Sales pipeline / evaluating",
  partner: "Active business partner",
  former_partner: "Previously an active business partner",
  prospective_partner: "Exploring partnership",
  former_prospective_partner: "Previously explored partnership; did not materialize",
  candidate: "Hiring pipeline",
  vendor: "Service provider",
  team: "Active day-to-day teammate (any org; embedded in my work)",
  colleague: "Former teammate or same-org peer (not currently active on my team)",
  friend: "Personal relationship",
  family: "Family member",
  connection: "One-off networking, acquaintance",
};

export const CALL_TYPE_TAGS = [
  "sales",
  "qualification",
  "prospecting",
  "demo",
  "onboarding",
  "check_in",
  "advisory",
  "pitch",
  "interview",
  "planning",
  "strategy",
  "networking",
  "internal",
  "meetings",
  "social",
] as const;

export type CallTypeTag = (typeof CALL_TYPE_TAGS)[number];

export const CALL_TYPE_DESCRIPTIONS: Record<CallTypeTag, string> = {
  sales: "Sales process call",
  qualification: "Qualifying a prospect",
  prospecting: "Early outreach / discovery",
  demo: "Product demo",
  onboarding: "New client starting",
  check_in: "Recurring sync with active client",
  advisory:
    "Advisory call (auto-derived when every external attendee has advisor_to; manual override allowed)",
  pitch: "I'm pitching (fundraising / partnership)",
  interview: "Hiring interview",
  planning: "Planning session",
  strategy: "Strategy session",
  networking: "Meet & greet",
  internal: "Internal-only meeting (auto-derived from meeting_type)",
  meetings: "Generic meeting / project sync (catch-all when no specific call type applies)",
  social: "Social / personal",
};

/**
 * Company-level relationship tags (Sprint 7).
 *
 * Applied per-domain in config/labels.yml under `companies:`. Orgs may
 * carry multiple tags (e.g. Alistova = partner_org + vendor_org).
 *
 * Semantics: **override**. Org tags act as a prior / suggestion when
 * generating person-label proposals; they are never automatically projected
 * as person tags. A person's explicit relationship always wins.
 *
 * No `family_org` / `friend_org` / `team_org` -- those stay person-level.
 */
export const COMPANY_RELATIONSHIP_TAGS = [
  "self",
  "client_org",
  "former_client_org",
  "prospective_client_org",
  "partner_org",
  "former_partner_org",
  "prospective_partner_org",
  "former_prospective_partner_org",
  "advisor_to_org",
  "advisor_org",
  "prospective_advisor_org",
  "vendor_org",
  "former_vendor_org",
  "friend_org",
] as const;

export type CompanyRelationshipTag = (typeof COMPANY_RELATIONSHIP_TAGS)[number];

export const COMPANY_RELATIONSHIP_DESCRIPTIONS: Record<
  CompanyRelationshipTag,
  string
> = {
  self: "My own organization",
  client_org: "Active paid client organization",
  former_client_org: "Previously a paid client organization",
  prospective_client_org: "Sales pipeline / evaluating",
  partner_org: "Active business partner organization",
  former_partner_org: "Previously an active business partner organization",
  prospective_partner_org: "Exploring partnership",
  former_prospective_partner_org:
    "Previously explored partnership; did not materialize",
  advisor_to_org: "I advise this organization",
  advisor_org: "This organization advises me",
  prospective_advisor_org: "Exploring them as a potential advisor",
  vendor_org: "Service provider organization",
  former_vendor_org: "Previously a service provider organization",
  friend_org: "Personal-friendship organization (no commercial relationship)",
};

const RELATIONSHIP_SET: Set<string> = new Set(RELATIONSHIP_TAGS);
const CALL_TYPE_SET: Set<string> = new Set(CALL_TYPE_TAGS);
const COMPANY_RELATIONSHIP_SET: Set<string> = new Set(COMPANY_RELATIONSHIP_TAGS);

export function isRelationshipTag(s: string): s is RelationshipTag {
  return RELATIONSHIP_SET.has(s);
}

export function isCallTypeTag(s: string): s is CallTypeTag {
  return CALL_TYPE_SET.has(s);
}

export function isCompanyRelationshipTag(
  s: string
): s is CompanyRelationshipTag {
  return COMPANY_RELATIONSHIP_SET.has(s);
}

export interface PersonLabelEntry {
  relationships: RelationshipTag[];
  notes?: string;
}

export interface MeetingLabelEntry {
  call_types: CallTypeTag[];
  notes?: string;
}

export interface CompanyLabelEntry {
  relationships: CompanyRelationshipTag[];
  notes?: string;
}

export interface Labels {
  people: Map<string, PersonLabelEntry>; // email -> entry
  meetings: Map<number, MeetingLabelEntry>; // recording_id -> entry
  companies: Map<string, CompanyLabelEntry>; // domain -> entry
  /**
   * Explicitly excluded from prep dossier candidate lists (reviewed as
   * "no taxonomy label needed" — e.g. random vendor inbox, school email).
   * Does not project to SQLite; dossier generators only.
   */
  skippedPeople: Set<string>;
  skippedCompanies: Set<string>;
}

interface RawLabels {
  people?: Record<
    string,
    { relationships?: unknown; notes?: unknown } | null | undefined
  >;
  meetings?: Record<
    string | number,
    { call_types?: unknown; notes?: unknown } | null | undefined
  >;
  companies?: Record<
    string,
    { relationships?: unknown; notes?: unknown } | null | undefined
  >;
  skipped?: {
    people?: unknown;
    companies?: unknown;
  };
}

/**
 * Load labels from config/labels.yml.
 *
 * Tolerates missing file (returns empty Labels so fresh checkouts still work).
 * Unknown tags are warned to stderr and skipped. Malformed entries are
 * skipped with a warning; we never throw on bad data.
 */
export function loadLabels(path: string = LABELS_PATH): Labels {
  const empty: Labels = {
    people: new Map(),
    meetings: new Map(),
    companies: new Map(),
    skippedPeople: new Set(),
    skippedCompanies: new Set(),
  };

  if (!existsSync(path)) return empty;

  let raw: RawLabels;
  try {
    const text = readFileSync(path, "utf-8");
    raw = (parseYaml(text) as RawLabels) ?? {};
  } catch (err) {
    console.warn(`[labels] failed to parse ${path}: ${(err as Error).message}`);
    return empty;
  }

  const labels: Labels = {
    people: new Map(),
    meetings: new Map(),
    companies: new Map(),
    skippedPeople: new Set(),
    skippedCompanies: new Set(),
  };

  if (raw.people && typeof raw.people === "object") {
    for (const [emailRaw, entryRaw] of Object.entries(raw.people)) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const email = String(emailRaw).toLowerCase().trim();
      if (!email) continue;

      const tags = Array.isArray(entryRaw.relationships)
        ? (entryRaw.relationships as unknown[])
        : [];
      const valid: RelationshipTag[] = [];
      for (const t of tags) {
        const s = String(t).trim();
        if (!s) continue;
        if (isRelationshipTag(s)) {
          if (!valid.includes(s)) valid.push(s);
        } else {
          console.warn(
            `[labels] unknown relationship tag "${s}" on ${email} - skipped`
          );
        }
      }
      if (valid.length === 0 && !entryRaw.notes) continue;

      const notes =
        typeof entryRaw.notes === "string" && entryRaw.notes.trim()
          ? String(entryRaw.notes).trim()
          : undefined;

      labels.people.set(email, { relationships: valid, notes });
    }
  }

  if (raw.meetings && typeof raw.meetings === "object") {
    for (const [idRaw, entryRaw] of Object.entries(raw.meetings)) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const id = Number(idRaw);
      if (!Number.isFinite(id) || !Number.isInteger(id)) {
        console.warn(`[labels] meeting key "${idRaw}" is not an integer - skipped`);
        continue;
      }

      const tags = Array.isArray(entryRaw.call_types)
        ? (entryRaw.call_types as unknown[])
        : [];
      const valid: CallTypeTag[] = [];
      for (const t of tags) {
        const s = String(t).trim();
        if (!s) continue;
        if (isCallTypeTag(s)) {
          if (!valid.includes(s)) valid.push(s);
        } else {
          console.warn(
            `[labels] unknown call_type tag "${s}" on meeting ${id} - skipped`
          );
        }
      }
      if (valid.length === 0 && !entryRaw.notes) continue;

      const notes =
        typeof entryRaw.notes === "string" && entryRaw.notes.trim()
          ? String(entryRaw.notes).trim()
          : undefined;

      labels.meetings.set(id, { call_types: valid, notes });
    }
  }

  if (raw.companies && typeof raw.companies === "object") {
    for (const [domainRaw, entryRaw] of Object.entries(raw.companies)) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const domain = String(domainRaw).toLowerCase().trim();
      if (!domain) continue;

      const tags = Array.isArray(entryRaw.relationships)
        ? (entryRaw.relationships as unknown[])
        : [];
      const valid: CompanyRelationshipTag[] = [];
      for (const t of tags) {
        const s = String(t).trim();
        if (!s) continue;
        if (isCompanyRelationshipTag(s)) {
          if (!valid.includes(s)) valid.push(s);
        } else {
          console.warn(
            `[labels] unknown company relationship tag "${s}" on ${domain} - skipped`
          );
        }
      }
      if (valid.length === 0 && !entryRaw.notes) continue;

      const notes =
        typeof entryRaw.notes === "string" && entryRaw.notes.trim()
          ? String(entryRaw.notes).trim()
          : undefined;

      labels.companies.set(domain, { relationships: valid, notes });
    }
  }

  if (raw.skipped && typeof raw.skipped === "object") {
    const sp = raw.skipped.people;
    if (Array.isArray(sp)) {
      for (const e of sp) {
        const email = String(e).toLowerCase().trim();
        if (email) labels.skippedPeople.add(email);
      }
    }
    const sc = raw.skipped.companies;
    if (Array.isArray(sc)) {
      for (const d of sc) {
        const domain = String(d).toLowerCase().trim();
        if (domain) labels.skippedCompanies.add(domain);
      }
    }
  }

  return labels;
}

/**
 * Project the loaded labels into SQLite's person_labels / meeting_labels /
 * company_labels tables. Safe to call after initSchema + clearAll; the
 * tables are treated as pure projections of the YAML.
 *
 * Emails / recording_ids / domains that don't exist in the primary tables
 * are warned but not inserted (the FK would reject them anyway). The source
 * of truth YAML is never mutated by this function.
 */
export function applyLabelsToSqlite(
  db: Database.Database,
  labels: Labels
): {
  peopleApplied: number;
  meetingsApplied: number;
  companiesApplied: number;
  skipped: string[];
} {
  db.exec(
    "DELETE FROM person_labels; DELETE FROM meeting_labels; DELETE FROM company_labels;"
  );

  const participantExists = db.prepare(
    "SELECT 1 FROM participants WHERE email = ?"
  );
  const meetingExists = db.prepare(
    "SELECT 1 FROM meetings WHERE recording_id = ?"
  );
  const companyExists = db.prepare("SELECT 1 FROM companies WHERE domain = ?");

  const insertPerson = db.prepare(
    "INSERT OR IGNORE INTO person_labels (email, tag, notes) VALUES (?, ?, ?)"
  );
  const insertMeeting = db.prepare(
    "INSERT OR IGNORE INTO meeting_labels (recording_id, tag, notes) VALUES (?, ?, ?)"
  );
  const insertCompany = db.prepare(
    "INSERT OR IGNORE INTO company_labels (domain, tag, notes) VALUES (?, ?, ?)"
  );

  const skipped: string[] = [];
  let peopleApplied = 0;
  let meetingsApplied = 0;
  let companiesApplied = 0;

  const txn = db.transaction(() => {
    for (const [email, entry] of labels.people) {
      if (!participantExists.get(email)) {
        skipped.push(`person:${email} (not in participants)`);
        continue;
      }
      for (const tag of entry.relationships) {
        const r = insertPerson.run(email, tag, entry.notes ?? null);
        if (r.changes > 0) peopleApplied++;
      }
    }

    for (const [id, entry] of labels.meetings) {
      if (!meetingExists.get(id)) {
        skipped.push(`meeting:${id} (not in meetings)`);
        continue;
      }
      for (const tag of entry.call_types) {
        const r = insertMeeting.run(id, tag, entry.notes ?? null);
        if (r.changes > 0) meetingsApplied++;
      }
    }

    for (const [domain, entry] of labels.companies) {
      if (!companyExists.get(domain)) {
        skipped.push(`company:${domain} (not in companies)`);
        continue;
      }
      for (const tag of entry.relationships) {
        const r = insertCompany.run(domain, tag, entry.notes ?? null);
        if (r.changes > 0) companiesApplied++;
      }
    }
  });

  txn();

  return { peopleApplied, meetingsApplied, companiesApplied, skipped };
}

/** Convenience: read relationships for a given email from SQLite. */
export function getPersonRelationships(
  db: Database.Database,
  email: string
): string[] {
  const rows = db
    .prepare("SELECT tag FROM person_labels WHERE email = ? ORDER BY tag")
    .all(email.toLowerCase()) as { tag: string }[];
  return rows.map((r) => r.tag);
}

/** Convenience: read call_types for a given recording_id from SQLite. */
export function getMeetingCallTypes(
  db: Database.Database,
  recordingId: number
): string[] {
  const rows = db
    .prepare(
      "SELECT tag FROM meeting_labels WHERE recording_id = ? ORDER BY tag"
    )
    .all(recordingId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

/** Convenience: read relationship tags for a given company domain from SQLite. */
export function getCompanyRelationships(
  db: Database.Database,
  domain: string
): string[] {
  const rows = db
    .prepare("SELECT tag FROM company_labels WHERE domain = ? ORDER BY tag")
    .all(domain.toLowerCase()) as { tag: string }[];
  return rows.map((r) => r.tag);
}
