/**
 * Triage / signal extraction for label dossiers (Sprint 7 dossier v2).
 *
 * Purpose: cut the per-batch question count from "every candidate" down to
 * "only the ambiguous ones" by:
 *   - auto-skipping clearly-irrelevant candidates (1 cold meeting, internal
 *     noise, role inboxes)
 *   - drafting high-confidence proposals (org-label inheritance, is_self,
 *     strong keyword + cadence signal)
 *   - surfacing only mid-confidence cases for manual review
 *
 * Confidence levels:
 *   A_PROPOSE  -- high confidence: pre-filled draft, opt-in auto-apply
 *   A_SKIP     -- high confidence: hide from dossier (count-only)
 *   B          -- medium: surface for human review (with suggestion if any)
 *   C          -- low / no signal: hide as count-only, opt-in --include-low
 *
 * All functions are pure: SQL reads happen upstream in candidates.ts. We
 * only consume the Candidate payloads.
 */

import type {
  CompanyCandidate,
  PersonCandidate,
} from "./candidates.js";
import type {
  Labels,
  CompanyRelationshipTag,
  RelationshipTag,
} from "./labels.js";

export type Confidence = "A_PROPOSE" | "A_SKIP" | "B" | "C";

export interface CompanyTriage {
  domain: string;
  confidence: Confidence;
  suggested: CompanyRelationshipTag[];
  reason: string;
  signals: CompanySignals;
}

export interface PersonTriage {
  email: string;
  confidence: Confidence;
  suggested: RelationshipTag[];
  reason: string;
  signals: PersonSignals;
}

export interface CompanySignals {
  recency_days: number | null;
  meeting_count: number;
  contact_count: number;
  is_self: boolean;
  domain_shape: DomainShape;
  has_labeled_people: boolean;
  inherited_org_tag: CompanyRelationshipTag | null;
  /** Distribution of org-mappable tags across labeled people at this org.
   *  Keys are the org-level tag, values are the count of distinct people
   *  carrying the corresponding person-level tag. Empty if no labeled
   *  people. Used to surface mixed-tag conflicts in dossier review. */
  person_tag_distribution: Record<string, number>;
  /** True iff at least 2 distinct org-mappable tags appear among the
   *  labeled people (e.g. one client + one prospective_partner). */
  has_inheritance_conflict: boolean;
  keyword_hits: KeywordHit[];
  title_hits: TitleHit[];
}

export interface PersonSignals {
  recency_days: number | null;
  meeting_count: number;
  is_external: boolean;
  domain_shape: DomainShape;
  org_label: CompanyRelationshipTag | null;
  inherited_person_tag: RelationshipTag | null;
  /** All org-mappable tags we observe on labeled co-attendees at the
   *  same domain. Used to flag when an inherited tag would disagree
   *  with what the team already carries. */
  org_person_distribution: Record<string, number>;
  keyword_hits: KeywordHit[];
  title_hits: TitleHit[];
  is_role_inbox: boolean;
}

export type DomainShape =
  | "self"
  | "personal" // gmail, yahoo, hotmail, outlook, icloud, etc.
  | "educational"
  | "corporate"
  | "unknown";

export type KeywordHit =
  | "sales"
  | "advisory"
  | "networking"
  | "investor"
  | "recurring"
  | "hiring"
  | "vendor";

export type TitleHit =
  | "discovery"
  | "demo"
  | "intro"
  | "standup"
  | "check_in"
  | "interview"
  | "networking_event";

const SALES_KEYWORDS = [
  "demo ",
  "pricing",
  "proposal",
  "quote",
  "sow",
  "msa",
  "contract",
  "onboard",
  "kickoff",
  "pilot",
  "trial period",
  "purchase order",
];
const ADVISORY_KEYWORDS = [
  "advisor",
  "advise",
  "mentor",
  "coaching",
  "office hours",
];
const NETWORKING_KEYWORDS = [
  "intro call",
  "intro meeting",
  "networking",
  "coffee chat",
  "meet & greet",
  "meet and greet",
  "first call",
];
const INVESTOR_KEYWORDS = [
  "raise",
  "fundraise",
  "investor",
  "investment",
  "cap table",
  "term sheet",
  "valuation",
  "bridge round",
  "seed round",
];
const RECURRING_KEYWORDS = [
  "weekly",
  "standup",
  "stand-up",
  "check-in",
  "check in",
  "sync",
  "1:1",
  "one-on-one",
  "one on one",
  "biweekly",
  "monthly sync",
];
const HIRING_KEYWORDS = [
  "interview",
  "candidate",
  "hiring",
  "job description",
  "role description",
  "offer letter",
];
const VENDOR_KEYWORDS = [
  "supplier",
  "vendor",
  "invoice",
  "procurement",
  "subscription renewal",
  "license",
];

const TITLE_DISCOVERY = /\b(discovery|qualification)\b/i;
const TITLE_DEMO = /\bdemo\b/i;
const TITLE_INTRO = /\b(intro|introduction)\b[:\s]/i;
const TITLE_STANDUP = /\b(standup|stand-up|daily)\b/i;
const TITLE_CHECKIN = /\b(check[- ]?in|sync|weekly|bi-?weekly|1:1|one[- ]on[- ]one)\b/i;
const TITLE_INTERVIEW = /\binterview\b/i;
const TITLE_NETWORKING = /\b(networking|meetup|coffee)\b/i;

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.ca",
  "hotmail.com",
  "hotmail.ca",
  "outlook.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "tutanota.com",
  "live.com",
  "msn.com",
  "qq.com",
  "163.com",
  "yandex.com",
  "duck.com",
]);

const ROLE_INBOX_LOCALPARTS = new Set([
  "sales",
  "info",
  "hello",
  "support",
  "contact",
  "admin",
  "office",
  "team",
  "noreply",
  "no-reply",
  "donotreply",
  "marketing",
  "billing",
  "accounts",
  "hr",
  "recruiting",
  "jobs",
]);

/**
 * Map person-level relationship tag to its org-level analog (when one
 * exists). Used both for inheriting org tags from labeled people and for
 * propagating org defaults down to person proposals.
 */
const PERSON_TO_ORG: Partial<Record<RelationshipTag, CompanyRelationshipTag>> =
  {
    client: "client_org",
    former_client: "former_client_org",
    prospective_client: "prospective_client_org",
    partner: "partner_org",
    former_partner: "former_partner_org",
    prospective_partner: "prospective_partner_org",
    former_prospective_partner: "former_prospective_partner_org",
    advisor_to: "advisor_to_org",
    advisor: "advisor_org",
    prospective_advisor: "prospective_advisor_org",
    vendor: "vendor_org",
  };

const ORG_TO_PERSON: Partial<Record<CompanyRelationshipTag, RelationshipTag>> =
  {
    client_org: "client",
    former_client_org: "former_client",
    prospective_client_org: "prospective_client",
    partner_org: "partner",
    former_partner_org: "former_partner",
    prospective_partner_org: "prospective_partner",
    former_prospective_partner_org: "former_prospective_partner",
    advisor_to_org: "advisor_to",
    advisor_org: "advisor",
    prospective_advisor_org: "prospective_advisor",
    vendor_org: "vendor",
  };

function daysSince(iso: string | null | undefined, today: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((today.getTime() - t) / 86_400_000);
}

function classifyDomain(
  domain: string | null | undefined,
  myDomain: string | null
): DomainShape {
  if (!domain) return "unknown";
  const d = domain.toLowerCase();
  if (myDomain && d === myDomain) return "self";
  if (PERSONAL_DOMAINS.has(d)) return "personal";
  if (d.endsWith(".edu") || /\.ac\.[a-z]{2,3}$/.test(d) || d.endsWith(".edu.au"))
    return "educational";
  return "corporate";
}

function localPart(email: string): string {
  return email.split("@")[0]?.toLowerCase() ?? "";
}

function isRoleInbox(email: string): boolean {
  return ROLE_INBOX_LOCALPARTS.has(localPart(email));
}

function scanText(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
}

function extractKeywordHits(text: string): KeywordHit[] {
  const hits: KeywordHit[] = [];
  if (scanText(text, SALES_KEYWORDS)) hits.push("sales");
  if (scanText(text, ADVISORY_KEYWORDS)) hits.push("advisory");
  if (scanText(text, NETWORKING_KEYWORDS)) hits.push("networking");
  if (scanText(text, INVESTOR_KEYWORDS)) hits.push("investor");
  if (scanText(text, RECURRING_KEYWORDS)) hits.push("recurring");
  if (scanText(text, HIRING_KEYWORDS)) hits.push("hiring");
  if (scanText(text, VENDOR_KEYWORDS)) hits.push("vendor");
  return hits;
}

function extractTitleHits(titles: string[]): TitleHit[] {
  const hits = new Set<TitleHit>();
  for (const t of titles) {
    if (TITLE_DISCOVERY.test(t)) hits.add("discovery");
    if (TITLE_DEMO.test(t)) hits.add("demo");
    if (TITLE_INTRO.test(t)) hits.add("intro");
    if (TITLE_STANDUP.test(t)) hits.add("standup");
    if (TITLE_CHECKIN.test(t)) hits.add("check_in");
    if (TITLE_INTERVIEW.test(t)) hits.add("interview");
    if (TITLE_NETWORKING.test(t)) hits.add("networking_event");
  }
  return [...hits];
}

interface InheritanceResult {
  tag: CompanyRelationshipTag;
  /** How many distinct labeled people back this tag. */
  support: number;
  /** Confidence we should attach -- "strong" if multiple-people support
   *  or single-person with a strong commercial tag, "weak" otherwise. */
  strength: "strong" | "weak";
  /** Full distribution of all org-mappable tags found across the people
   *  at this org. Used to detect conflicts (multiple distinct tags). */
  distribution: Map<CompanyRelationshipTag, number>;
}

/**
 * Look at the labeled people at this company and try to infer the dominant
 * org-level tag. Returns null if no signals.
 *
 * - >=2 people sharing same org-mappable tag => strong (A_PROPOSE candidate)
 * - 1 person with strong commercial tag (client/partner/advisor_to/vendor)
 *   on a high-meeting-count org => weak (B suggestion)
 */
/**
 * Render an inheritance distribution like
 *   "client_org=2, prospective_partner_org=1"
 * for use in human-facing dossier reasons.
 */
function formatDistribution(
  dist: Map<CompanyRelationshipTag, number>
): string {
  return [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `${tag}=${n}`)
    .join(", ");
}

function inheritOrgTagFromPeople(
  people: CompanyCandidate["people"]
): InheritanceResult | null {
  const counts = new Map<CompanyRelationshipTag, number>();
  for (const p of people) {
    for (const tag of p.relationships) {
      const orgTag = PERSON_TO_ORG[tag as RelationshipTag];
      if (!orgTag) continue;
      counts.set(orgTag, (counts.get(orgTag) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: CompanyRelationshipTag | null = null;
  let bestCount = 0;
  for (const [tag, n] of counts) {
    if (n > bestCount) {
      best = tag;
      bestCount = n;
    }
  }
  if (!best) return null;
  return {
    tag: best,
    support: bestCount,
    strength: bestCount >= 2 ? "strong" : "weak",
    distribution: counts,
  };
}

export interface TriageOptions {
  /** Reference date for recency. Defaults to today (UTC midnight). */
  today?: Date;
  /** My primary domain (for self / external classification). */
  myDomain?: string | null;
}

export function triageCompany(
  c: CompanyCandidate,
  opts: TriageOptions = {}
): CompanyTriage {
  const today = opts.today ?? new Date();
  const myDomain = opts.myDomain ?? null;

  const domainShape = classifyDomain(c.domain, myDomain);
  const recencyDays = daysSince(c.last_seen, today);
  const meetingCount = c.meeting_count;

  const summaries = c.representative_meetings
    .map((m) => m.summary ?? "")
    .join("\n");
  const titles = c.representative_meetings.map((m) => m.title);
  const keywordHits = extractKeywordHits(summaries);
  const titleHits = extractTitleHits(titles);

  const inheritance = inheritOrgTagFromPeople(c.people);
  const hasLabeledPeople = c.people.some((p) => p.relationships.length > 0);

  const distribution: Record<string, number> = {};
  if (inheritance) {
    for (const [tag, n] of inheritance.distribution) distribution[tag] = n;
  }
  const distinctOrgTags = inheritance ? inheritance.distribution.size : 0;
  const hasInheritanceConflict = distinctOrgTags >= 2;

  const signals: CompanySignals = {
    recency_days: recencyDays,
    meeting_count: meetingCount,
    contact_count: c.contact_count,
    is_self: c.is_self,
    domain_shape: domainShape,
    has_labeled_people: hasLabeledPeople,
    inherited_org_tag: inheritance?.tag ?? null,
    person_tag_distribution: distribution,
    has_inheritance_conflict: hasInheritanceConflict,
    keyword_hits: keywordHits,
    title_hits: titleHits,
  };

  // 1. is_self -- A_PROPOSE
  if (c.is_self) {
    return mk("A_PROPOSE", ["self"], "Domain matches my primary domain");
  }

  // 2. Strong inheritance (>=2 people share an org-mappable tag).
  //    Auto-propose only when there is no conflicting tag among the
  //    other labeled people. Otherwise demote to B with a Conflict note
  //    so it surfaces for explicit review.
  if (inheritance && inheritance.strength === "strong") {
    if (hasInheritanceConflict) {
      return mk(
        "B",
        [inheritance.tag],
        `Inheritance conflict: ${formatDistribution(inheritance.distribution)}; majority is ${inheritance.tag} (${inheritance.support}/${c.people.filter((p) => p.relationships.length > 0).length} labeled people)`
      );
    }
    return mk(
      "A_PROPOSE",
      [inheritance.tag],
      `Inherited from labeled people (${inheritance.support} share ${inheritance.tag})`
    );
  }

  // 2b. Weak inheritance with a conflicting other tag -- B with explicit conflict note.
  if (inheritance && inheritance.strength === "weak" && hasInheritanceConflict) {
    return mk(
      "B",
      [inheritance.tag],
      `Inheritance conflict: ${formatDistribution(inheritance.distribution)} -- review which (if any) belongs at the org level`
    );
  }

  // 3. Cadence-based detection BEFORE skip-rules so dormant high-volume
  //    accounts surface as former_client_org rather than getting dropped.
  const recurringCadence =
    titleHits.includes("check_in") ||
    titleHits.includes("standup") ||
    keywordHits.includes("recurring");

  if (meetingCount >= 10 && recurringCadence && recencyDays !== null) {
    if (recencyDays > 180) {
      return mk(
        "B",
        ["former_client_org"],
        `Dormant high-cadence account (${meetingCount} meetings, last ${recencyDays}d ago, recurring/check-in cadence)`
      );
    }
    if (recencyDays <= 180) {
      return mk(
        "B",
        ["client_org"],
        `Active recurring cadence (${meetingCount} meetings, last ${recencyDays}d ago)`
      );
    }
  }

  // 4. Weak inheritance (1 labeled person with strong commercial tag) -- B
  if (inheritance && inheritance.strength === "weak" && meetingCount >= 5) {
    return mk(
      "B",
      [inheritance.tag],
      `One labeled contact at this org (${inheritance.tag}); ${meetingCount} meetings -- review whether org-level tag applies`
    );
  }

  // 5. Active prospect (small footprint, recent, sales signal)
  if (
    meetingCount <= 4 &&
    recencyDays !== null &&
    recencyDays < 120 &&
    (keywordHits.includes("sales") ||
      titleHits.includes("demo") ||
      titleHits.includes("discovery"))
  ) {
    return mk(
      "B",
      ["prospective_client_org"],
      `Recent (<120d), few meetings (${meetingCount}), sales/demo signal`
    );
  }

  // 6. Active recurring without enough meetings to hit rule 3
  if (
    meetingCount >= 4 &&
    recencyDays !== null &&
    recencyDays < 90 &&
    recurringCadence
  ) {
    return mk(
      "B",
      ["client_org"],
      `Recurring cadence + recent + ${meetingCount} meetings`
    );
  }

  // 7. Cold one-off, far in the past -- A_SKIP
  if (
    meetingCount === 1 &&
    recencyDays !== null &&
    recencyDays > 365 &&
    keywordHits.length === 0 &&
    titleHits.length === 0
  ) {
    return mk(
      "A_SKIP",
      [],
      "1 meeting >1y ago, no commercial/networking signal"
    );
  }

  // 8. Personal email domain
  if (domainShape === "personal") {
    return mk(
      "C",
      [],
      "Personal email domain; tag the individual, not the 'org'"
    );
  }

  // 9. Intro / networking single-touch
  if (
    (titleHits.includes("intro") ||
      titleHits.includes("networking_event") ||
      keywordHits.includes("networking")) &&
    meetingCount <= 2
  ) {
    return mk("C", [], "Intro / networking only; usually no org-level tag");
  }

  // 10. Hiring
  if (keywordHits.includes("hiring") || titleHits.includes("interview")) {
    return mk(
      "B",
      [],
      "Hiring / interview signal -- usually no org tag, but review"
    );
  }

  // 11. Investor (no vocab fit yet)
  if (keywordHits.includes("investor")) {
    return mk(
      "B",
      [],
      "Investor signal -- no org-level vocab yet; consider notes-only"
    );
  }

  // 12. Multi-meeting external company with no clear pattern -- still review
  if (meetingCount >= 3) {
    return mk(
      "B",
      [],
      `${meetingCount} meetings, no clear cadence/sales pattern -- review manually`
    );
  }

  // 13. Default: low signal
  if (keywordHits.length === 0 && titleHits.length === 0) {
    return mk("C", [], "No keyword or title signals detected");
  }

  return mk(
    "B",
    [],
    `Signals present (${[...keywordHits, ...titleHits].join(", ")}) but no clear vocab fit`
  );

  function mk(
    confidence: Confidence,
    suggested: CompanyRelationshipTag[],
    reason: string
  ): CompanyTriage {
    return { domain: c.domain, confidence, suggested, reason, signals };
  }
}

export function triagePerson(
  p: PersonCandidate,
  labels: Labels,
  opts: TriageOptions = {}
): PersonTriage {
  const today = opts.today ?? new Date();
  const myDomain = opts.myDomain ?? null;

  const domainShape = classifyDomain(p.domain, myDomain);
  const recencyDays = daysSince(p.last_seen, today);
  const meetingCount = p.meeting_count;
  const roleInbox = isRoleInbox(p.email);

  const summaries = p.meetings.map((m) => m.summary ?? "").join("\n");
  const titles = p.meetings.map((m) => m.title);
  const keywordHits = extractKeywordHits(summaries);
  const titleHits = extractTitleHits(titles);

  let orgTag: CompanyRelationshipTag | null = null;
  let inheritedPersonTags: RelationshipTag[] = [];
  if (p.domain) {
    const orgEntry = labels.companies.get(p.domain.toLowerCase());
    if (orgEntry && orgEntry.relationships.length > 0) {
      // Inherit ALL org tags that have a person-level analog (so a company
      // tagged advisor_to_org + client_org seeds person tag advisor_to + client).
      for (const t of orgEntry.relationships) {
        const personTag = ORG_TO_PERSON[t];
        if (personTag && !inheritedPersonTags.includes(personTag)) {
          inheritedPersonTags.push(personTag);
        }
      }
      // Keep orgTag for signal display + colleague-conflict comparison;
      // pick the first mappable one (matches the dominant signal).
      orgTag = orgEntry.relationships.find((t) => ORG_TO_PERSON[t]) ?? null;
    }
  }
  const inheritedPersonTag = inheritedPersonTags[0] ?? null;

  // Distribution of org-mappable tags carried by labeled colleagues at
  // the same domain. Drives conflict detection: if the inherited tag
  // disagrees with what the team already has, demote A_PROPOSE to B.
  const orgPersonDistribution: Record<string, number> = {};
  if (p.domain) {
    const dom = p.domain.toLowerCase();
    for (const co of p.co_attendees_known) {
      const coDomain = co.email.split("@")[1]?.toLowerCase();
      if (coDomain !== dom) continue;
      for (const tag of co.relationships) {
        const orgEquiv = PERSON_TO_ORG[tag as RelationshipTag];
        if (!orgEquiv) continue;
        orgPersonDistribution[orgEquiv] =
          (orgPersonDistribution[orgEquiv] ?? 0) + 1;
      }
    }
  }
  const distinctColleagueOrgTags = Object.keys(orgPersonDistribution).length;
  const colleagueConflictsWithInheritance =
    inheritedPersonTag !== null &&
    orgTag !== null &&
    distinctColleagueOrgTags > 0 &&
    !(orgTag in orgPersonDistribution && distinctColleagueOrgTags === 1);

  const signals: PersonSignals = {
    recency_days: recencyDays,
    meeting_count: meetingCount,
    is_external: p.is_external,
    domain_shape: domainShape,
    org_label: orgTag,
    inherited_person_tag: inheritedPersonTag,
    org_person_distribution: orgPersonDistribution,
    keyword_hits: keywordHits,
    title_hits: titleHits,
    is_role_inbox: roleInbox,
  };

  if (domainShape === "self") {
    return {
      email: p.email,
      confidence: "A_SKIP",
      suggested: [],
      reason: "My own domain — no useful person-level tag for myself",
      signals,
    };
  }

  if (roleInbox && meetingCount <= 2 && keywordHits.length === 0) {
    return {
      email: p.email,
      confidence: "A_SKIP",
      suggested: [],
      reason: "Role inbox (sales@/info@/etc.) with no commercial signal",
      signals,
    };
  }

  if (
    meetingCount === 1 &&
    recencyDays !== null &&
    recencyDays > 365 &&
    keywordHits.length === 0
  ) {
    return {
      email: p.email,
      confidence: "A_SKIP",
      suggested: [],
      reason: "1 meeting >1y ago, no signal",
      signals,
    };
  }

  if (inheritedPersonTag) {
    if (colleagueConflictsWithInheritance) {
      const dist = Object.entries(orgPersonDistribution)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${n}`)
        .join(", ");
      return {
        email: p.email,
        confidence: "B",
        suggested: [inheritedPersonTag],
        reason: `Inheritance conflict: org=${orgTag} but colleagues at ${p.domain} carry ${dist} -- review whether this person follows the org default or a different teammate's tag`,
        signals,
      };
    }
    return {
      email: p.email,
      confidence: "A_PROPOSE",
      suggested: inheritedPersonTags,
      reason:
        inheritedPersonTags.length > 1
          ? `Inherited from org tags on ${p.domain} (${inheritedPersonTags.join(" + ")})`
          : `Inherited from org tag ${orgTag} on ${p.domain}`,
      signals,
    };
  }

  if (
    meetingCount <= 3 &&
    recencyDays !== null &&
    recencyDays < 90 &&
    (keywordHits.includes("sales") || titleHits.includes("demo") || titleHits.includes("discovery"))
  ) {
    return {
      email: p.email,
      confidence: "B",
      suggested: ["prospective_client"],
      reason: "Recent + sales/demo signal",
      signals,
    };
  }

  // Tightened candidate detection: require an explicit title-level hit
  // ("Interview with X", "Hiring screen", etc.). Summary-level "interview"
  // / "candidate" keywords trip on too many unrelated contexts (podcast
  // interviews, exit interviews, "interviewing customers", a hiring sub-
  // topic mentioned in a sprint check-in, etc.) so we no longer infer
  // candidate from summary text alone.
  if (titleHits.includes("interview")) {
    return {
      email: p.email,
      confidence: "B",
      suggested: ["candidate"],
      reason: "Interview meeting title detected",
      signals,
    };
  }

  if (
    (titleHits.includes("intro") || titleHits.includes("networking_event") || keywordHits.includes("networking")) &&
    meetingCount <= 2
  ) {
    return {
      email: p.email,
      confidence: "C",
      suggested: [],
      reason: "Single intro / networking call",
      signals,
    };
  }

  if (keywordHits.length === 0 && titleHits.length === 0 && meetingCount <= 2) {
    return {
      email: p.email,
      confidence: "C",
      suggested: [],
      reason: "Few meetings, no detected signal",
      signals,
    };
  }

  return {
    email: p.email,
    confidence: "B",
    suggested: [],
    reason: `Signals present (${[...keywordHits, ...titleHits].join(", ") || "cadence only"}) but no clear default`,
    signals,
  };
}

export interface TriageBuckets<T> {
  draft: T[]; // A_PROPOSE  -- pre-fill into proposals
  skip: T[]; // A_SKIP     -- hidden, count-only
  review: T[]; // B          -- surface for human
  low: T[]; // C          -- hidden, opt-in
}

export function bucketCompanies(
  triages: CompanyTriage[]
): TriageBuckets<CompanyTriage> {
  const out: TriageBuckets<CompanyTriage> = {
    draft: [],
    skip: [],
    review: [],
    low: [],
  };
  for (const t of triages) {
    if (t.confidence === "A_PROPOSE") out.draft.push(t);
    else if (t.confidence === "A_SKIP") out.skip.push(t);
    else if (t.confidence === "B") out.review.push(t);
    else out.low.push(t);
  }
  return out;
}

export function bucketPeople(
  triages: PersonTriage[]
): TriageBuckets<PersonTriage> {
  const out: TriageBuckets<PersonTriage> = {
    draft: [],
    skip: [],
    review: [],
    low: [],
  };
  for (const t of triages) {
    if (t.confidence === "A_PROPOSE") out.draft.push(t);
    else if (t.confidence === "A_SKIP") out.skip.push(t);
    else if (t.confidence === "B") out.review.push(t);
    else out.low.push(t);
  }
  return out;
}
