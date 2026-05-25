#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./lib/db.js";
import {
  listMeetings,
  getMeeting,
  findPerson,
  findCompany,
  keywordSearch,
  semanticSearch,
  getEntityTimeline,
  getProjectStatus,
  verifyClaim,
  getTranscriptChunks,
} from "./lib/search.js";

const server = new McpServer({
  name: "fathom-kb",
  version: "0.1.0",
});

// Path to the fathom-research SKILL.md, served as an MCP resource so any
// connected client (Cursor, Claude Desktop, Claude Code) can fetch the
// research methodology directly from the MCP without depending on
// workspace-scoped Cursor skills. Source of truth lives at
// ../skills/fathom-research/SKILL.md and is symlinked into .cursor/skills/
// for in-workspace Cursor auto-discovery.
const FATHOM_RESEARCH_SKILL_PATH = join(
  import.meta.dirname,
  "..",
  "skills",
  "fathom-research",
  "SKILL.md"
);

server.registerTool(
  "list_meetings",
  {
    title: "List Meetings",
    description:
      "List meetings from the local Fathom knowledge base with optional filters. Returns the most recent first. Filters compose as AND across params; within the relationships or call_types arrays the semantics are OR.",
    inputSchema: {
      person: z
        .string()
        .optional()
        .describe("Filter by participant name or email substring"),
      company: z.string().optional().describe("Filter by company domain"),
      date_from: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD (inclusive)"),
      date_to: z
        .string()
        .optional()
        .describe("End date YYYY-MM-DD (inclusive)"),
      meeting_type: z
        .string()
        .optional()
        .describe(
          "Filter by meeting_type (e.g. one_or_more_external, internal_only)"
        ),
      relationships: z
        .array(z.string())
        .optional()
        .describe(
          "Person-relationship tags. Returns meetings with at least one participant carrying any of these tags (OR within the array). Valid tags: advisor_to, advisor, prospective_advisor, client, former_client, prospective_client, partner, former_partner, prospective_partner, former_prospective_partner, candidate, vendor, team, colleague, friend, family, connection."
        ),
      company_relationships: z
        .array(z.string())
        .optional()
        .describe(
          "Company-relationship tags (org-level). Returns meetings whose participating companies carry any of these tags. Use when the question is org-shaped (e.g. 'all client orgs', 'every vendor relationship'). Valid tags: self, client_org, former_client_org, prospective_client_org, partner_org, former_partner_org, prospective_partner_org, former_prospective_partner_org, advisor_to_org, advisor_org, prospective_advisor_org, vendor_org, former_vendor_org, friend_org."
        ),
      call_types: z
        .array(z.string())
        .optional()
        .describe(
          "Call-type tags. Returns meetings carrying any of these tags. Valid tags: sales, qualification, prospecting, demo, onboarding, check_in, advisory (auto-derived), pitch, interview, planning, strategy, networking, internal (auto-derived), meetings, social."
        ),
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const rows = listMeetings(db, {
        person: args.person,
        company: args.company,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        type: args.meeting_type,
        relationships: args.relationships,
        callTypes: args.call_types,
        companyRelationships: args.company_relationships,
        limit: args.limit,
      });

      // Enrich with companies + call-type tags so the LLM can see what
      // it's filtering on (and reason about it without a second round-trip).
      const companiesStmt = db.prepare(
        `SELECT domain FROM meeting_companies WHERE recording_id = ? ORDER BY domain`
      );
      const tagsStmt = db.prepare(
        `SELECT tag FROM meeting_labels WHERE recording_id = ? ORDER BY tag`
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: rows.length,
                meetings: rows.map((m) => ({
                  recording_id: m.recording_id,
                  title: m.title,
                  date: m.date,
                  duration_seconds: m.duration_seconds,
                  meeting_type: m.meeting_type,
                  recorded_by: m.recorded_by_name,
                  url: m.url,
                  has_transcript: m.has_transcript === 1,
                  companies: (
                    companiesStmt.all(m.recording_id) as Array<{
                      domain: string;
                    }>
                  ).map((r) => r.domain),
                  tags: (
                    tagsStmt.all(m.recording_id) as Array<{ tag: string }>
                  ).map((r) => r.tag),
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "get_meeting",
  {
    title: "Get Meeting",
    description:
      "Get full details for a specific meeting: participants, companies, duration, and summary.",
    inputSchema: {
      recording_id: z.number().int(),
      include_summary: z.boolean().optional().default(true),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const meeting = getMeeting(db, args.recording_id);
      if (!meeting) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No meeting with recording_id=${args.recording_id}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                recording_id: meeting.recording_id,
                title: meeting.title,
                date: meeting.date,
                duration_seconds: meeting.duration_seconds,
                meeting_type: meeting.meeting_type,
                url: meeting.url,
                share_url: meeting.share_url,
                recorded_by: {
                  name: meeting.recorded_by_name,
                  email: meeting.recorded_by_email,
                },
                participants: meeting.participants,
                companies: meeting.companies,
                has_transcript: meeting.has_transcript === 1,
                summary: args.include_summary
                  ? meeting.summary_markdown
                  : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "find_person",
  {
    title: "Find Person",
    description:
      "Find people who've participated in meetings by name or email substring. Returns meeting counts and date range.",
    inputSchema: {
      query: z.string().describe("Name or email substring"),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const rows = findPerson(db, args.query, args.limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: rows.length, people: rows }, null, 2),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "find_company",
  {
    title: "Find Company",
    description:
      "Find companies (by email domain) with meeting and contact counts.",
    inputSchema: {
      query: z.string().describe("Domain substring"),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const rows = findCompany(db, args.query, args.limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { count: rows.length, companies: rows },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "keyword_search",
  {
    title: "Keyword Search (FTS)",
    description:
      "Full-text SQLite FTS5 search over meeting titles and summaries. Use for precise terms, company names, acronyms. For conceptual queries prefer semantic_search.",
    inputSchema: {
      query: z.string().describe("FTS5 query (e.g. 'pricing OR discount')"),
      limit: z.number().int().min(1).max(50).optional().default(15),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const rows = keywordSearch(db, args.query, args.limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: rows.length,
                results: rows.map((r) => ({
                  recording_id: r.recording_id,
                  title: r.title,
                  date: r.date,
                  snippet: r.snippet,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "semantic_search",
  {
    title: "Semantic Search",
    description:
      "Vector search across transcript chunks and summaries. Best for conceptual questions ('objections about pricing', 'how we talk about onboarding'). Optional filters scope results to a person, company, date range, or taxonomy tags.",
    inputSchema: {
      query: z.string().describe("Natural-language question or phrase"),
      limit: z.number().int().min(1).max(30).optional().default(8),
      person: z
        .string()
        .optional()
        .describe("Scope to meetings with this person (name or email)"),
      company: z.string().optional().describe("Scope to this company domain"),
      date_from: z.string().optional().describe("YYYY-MM-DD"),
      date_to: z.string().optional().describe("YYYY-MM-DD"),
      relationships: z
        .array(z.string())
        .optional()
        .describe(
          "Person-relationship tags. Scope to meetings with at least one participant carrying any of these tags (OR within the array). See list_meetings for the valid vocab."
        ),
      company_relationships: z
        .array(z.string())
        .optional()
        .describe(
          "Company-relationship tags (org-level). Scope to meetings whose participating companies carry any of these tags. See list_meetings for the valid vocab."
        ),
      call_types: z
        .array(z.string())
        .optional()
        .describe(
          "Call-type tags. Scope to meetings carrying any of these tags (OR within the array). Includes auto-derived internal and advisory."
        ),
      min_distinct_meetings: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe(
          "If set, the result set is diversified so the first N hits come from N distinct meetings (where possible). Use 3+ when asking 'what does the user think about X'-style questions to avoid drawing conclusions from a single meeting."
        ),
    },
  },
  async (args) => {
    const hits = await semanticSearch(args.query, {
      limit: args.limit,
      person: args.person,
      company: args.company,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      relationships: args.relationships,
      callTypes: args.call_types,
      companyRelationships: args.company_relationships,
      minDistinctMeetings: args.min_distinct_meetings,
    });
    const distinctMeetings = new Set(hits.map((h) => h.recording_id)).size;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: hits.length,
              distinct_meetings: distinctMeetings,
              query: args.query,
              hits: hits.map((h) => ({
                recording_id: h.recording_id,
                meeting_title: h.meeting_title,
                meeting_date: h.meeting_date,
                participants: h.participants,
                kind: h.kind,
                start_timestamp: h.start_timestamp || undefined,
                speakers: h.speakers,
                text: h.text,
                distance: Number(h.distance.toFixed(4)),
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  "list_people_by_relationship",
  {
    title: "List People By Relationship",
    description:
      "Return every person carrying the given relationship tag. Useful for 'show me all clients', 'list my advisors', 'who are my prospective partners'. Optionally include each person's most recent meetings.",
    inputSchema: {
      tag: z
        .string()
        .describe(
          "Relationship tag: advisor_to, advisor, prospective_advisor, client, former_client, prospective_client, partner, former_partner, prospective_partner, former_prospective_partner, candidate, vendor, team, colleague, friend, family, connection."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max people to return (default 50)."),
      include_meetings: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include each person's 5 most recent meetings (recording_id + title + date)."
        ),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const peopleRows = db
        .prepare(
          `SELECT p.email, p.name, p.domain, p.first_seen, p.last_seen, p.meeting_count,
                  pl.notes
           FROM person_labels pl
           JOIN participants p ON p.email = pl.email
           WHERE pl.tag = ?
           ORDER BY p.meeting_count DESC, p.name COLLATE NOCASE
           LIMIT ?`
        )
        .all(args.tag, args.limit) as Array<{
        email: string;
        name: string;
        domain: string | null;
        first_seen: string;
        last_seen: string;
        meeting_count: number;
        notes: string | null;
      }>;

      const recentMeetings = args.include_meetings
        ? db.prepare(
            `SELECT m.recording_id, m.title, m.date
             FROM meeting_participants mp
             JOIN meetings m ON m.recording_id = mp.recording_id
             WHERE mp.email = ?
             ORDER BY m.date DESC
             LIMIT 5`
          )
        : null;

      const people = peopleRows.map((p) => ({
        email: p.email,
        name: p.name,
        domain: p.domain,
        first_seen: p.first_seen,
        last_seen: p.last_seen,
        meeting_count: p.meeting_count,
        notes: p.notes ?? undefined,
        recent_meetings: recentMeetings
          ? (recentMeetings.all(p.email) as Array<{
              recording_id: number;
              title: string;
              date: string;
            }>)
          : undefined,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tag: args.tag,
                count: people.length,
                people,
              },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "list_companies_by_relationship",
  {
    title: "List Companies By Relationship",
    description:
      "Return every company (domain) carrying the given company-relationship tag. Useful for org-shaped questions: 'show me all my client orgs', 'every former vendor', 'list partner organizations'. Optionally include each company's most recent meetings.",
    inputSchema: {
      tag: z
        .string()
        .describe(
          "Company-relationship tag: self, client_org, former_client_org, prospective_client_org, partner_org, former_partner_org, prospective_partner_org, former_prospective_partner_org, advisor_to_org, advisor_org, prospective_advisor_org, vendor_org, former_vendor_org, friend_org."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max companies to return (default 50)."),
      include_meetings: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include each company's 5 most recent meetings (recording_id + title + date)."
        ),
    },
  },
  async (args) => {
    const db = openDb();
    try {
      const companyRows = db
        .prepare(
          `SELECT c.domain, c.first_seen, c.last_seen, c.meeting_count, c.contact_count,
                  cl.notes
           FROM company_labels cl
           JOIN companies c ON c.domain = cl.domain
           WHERE cl.tag = ?
           ORDER BY c.meeting_count DESC, c.domain COLLATE NOCASE
           LIMIT ?`
        )
        .all(args.tag, args.limit) as Array<{
        domain: string;
        first_seen: string;
        last_seen: string;
        meeting_count: number;
        contact_count: number;
        notes: string | null;
      }>;

      const recentMeetings = args.include_meetings
        ? db.prepare(
            `SELECT m.recording_id, m.title, m.date
             FROM meeting_companies mc
             JOIN meetings m ON m.recording_id = mc.recording_id
             WHERE mc.domain = ?
             ORDER BY m.date DESC
             LIMIT 5`
          )
        : null;

      const companies = companyRows.map((c) => ({
        domain: c.domain,
        first_seen: c.first_seen,
        last_seen: c.last_seen,
        meeting_count: c.meeting_count,
        contact_count: c.contact_count,
        notes: c.notes ?? undefined,
        recent_meetings: recentMeetings
          ? (recentMeetings.all(c.domain) as Array<{
              recording_id: number;
              title: string;
              date: string;
            }>)
          : undefined,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tag: args.tag,
                count: companies.length,
                companies,
              },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      db.close();
    }
  }
);

server.registerTool(
  "build_context",
  {
    title: "Build Context Block",
    description:
      "Run a semantic search and return a markdown-formatted context block suitable for grounding an AI response. Use when you need evidence or quotes from meetings.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(20).optional().default(6),
      person: z.string().optional(),
      company: z.string().optional(),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      relationships: z.array(z.string()).optional(),
      company_relationships: z.array(z.string()).optional(),
      call_types: z.array(z.string()).optional(),
      min_distinct_meetings: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe(
          "If set, diversify the result set to span at least N distinct meetings where possible."
        ),
    },
  },
  async (args) => {
    const hits = await semanticSearch(args.query, {
      limit: args.limit,
      person: args.person,
      company: args.company,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      relationships: args.relationships,
      callTypes: args.call_types,
      companyRelationships: args.company_relationships,
      minDistinctMeetings: args.min_distinct_meetings,
    });
    const lines: string[] = [];
    lines.push(`# Context for: "${args.query}"`);
    lines.push("");
    if (hits.length === 0) {
      lines.push("_No matching chunks._");
    } else {
      hits.forEach((h, i) => {
        lines.push(`## [${i + 1}] ${h.meeting_title} (${h.meeting_date})`);
        lines.push(
          `- recording_id: ${h.recording_id} | kind: ${h.kind} | speakers: ${h.speakers}`
        );
        lines.push(`- participants: ${h.participants}`);
        if (h.start_timestamp)
          lines.push(
            `- timestamp: ${h.start_timestamp}${h.end_timestamp ? ` -> ${h.end_timestamp}` : ""}`
          );
        lines.push("");
        lines.push(h.text);
        lines.push("");
      });
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

server.registerTool(
  "get_entity_timeline",
  {
    title: "Get Entity Timeline",
    description:
      "Chronologically-ordered mentions of a person, company, project, or topic across meetings. Each entry has date, meeting_id, meeting_title, snippet, speakers (when known), and url. Use this instead of running semantic_search three times and trying to order the results — supports A1 (triangulation) and A3 (temporal resolution) from the fathom-research skill.",
    inputSchema: {
      entity: z
        .string()
        .describe("The person name/email, company domain, project name, or topic."),
      entity_type: z
        .enum(["person", "company", "project", "topic"])
        .describe(
          "How to look the entity up. 'person' and 'company' use relational filters; 'project' and 'topic' search the transcript/summary corpus."
        ),
      date_from: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
      date_to: z.string().optional().describe("YYYY-MM-DD (inclusive)"),
      limit: z.number().int().min(1).max(200).optional().default(30),
    },
  },
  async (args) => {
    const entries = await getEntityTimeline({
      entity: args.entity,
      entityType: args.entity_type,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              entity: args.entity,
              entity_type: args.entity_type,
              count: entries.length,
              date_range:
                entries.length > 0
                  ? { from: entries[0].date, to: entries[entries.length - 1].date }
                  : null,
              timeline: entries,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  "get_project_status",
  {
    title: "Get Project Status",
    description:
      "Infer the latest known state of a named project / deal / initiative from the most recent mentions. Returns status (active / paused / canceled / completed / unknown), the confirming meeting, and the full history. Heuristic keyword-based classification — confidence is explicit and the full evidence is always returned so the caller can verify. Use this instead of trusting whichever meeting happened to surface first in a generic search — this is the primitive that prevents the 'project was canceled weeks ago but I reported it as active' failure mode.",
    inputSchema: {
      project: z
        .string()
        .describe("The project / deal / initiative name (exact phrasing matters)."),
      as_of: z
        .string()
        .optional()
        .describe("Cap mentions to those on or before this YYYY-MM-DD."),
    },
  },
  async (args) => {
    const result = await getProjectStatus({
      project: args.project,
      asOf: args.as_of,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "verify_claim",
  {
    title: "Verify Claim",
    description:
      "Scan the meeting corpus for supporting AND contradicting evidence for a user-stated claim. Returns three buckets — supporting, contradicting, unclear — each with full quote text, speaker, date, and meeting url. Use this BEFORE asserting something like 'the user has said X', especially in roleplay or coaching modes (supports A4). Classification is heuristic (semantic retrieval + negation-proximity, or two-query retrieval if counter_claim is provided); the caller must re-read each quote before asserting.",
    inputSchema: {
      claim: z
        .string()
        .describe(
          "The claim to verify, phrased as a positive statement (e.g. 'Mitch wants to work with smaller companies')."
        ),
      counter_claim: z
        .string()
        .optional()
        .describe(
          "Optional negated form (e.g. 'Mitch wants to work with enterprise clients'). When provided, contradiction detection runs a second retrieval instead of relying on the negation heuristic — strongly preferred."
        ),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      person: z.string().optional(),
      company: z.string().optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .default(5)
        .describe("Max entries per bucket."),
    },
  },
  async (args) => {
    const result = await verifyClaim({
      claim: args.claim,
      counterClaim: args.counter_claim,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      person: args.person,
      company: args.company,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "get_transcript",
  {
    title: "Get Transcript",
    description:
      "Retrieve all indexed transcript chunks for a meeting, ordered by timestamp. Optional `speaker` substring filter. Note: many chunks show `speakers: \"Unknown\"` because Fathom did not attribute them — filtering by a specific name may return few or no rows until upstream speaker attribution is improved (see skill A2).",
    inputSchema: {
      recording_id: z.number().int(),
      speaker: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring match against the chunk's speaker field. Will match zero chunks for chunks where Fathom recorded the speaker as `Unknown`."
        ),
      include_summary: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, also return summary-kind chunks (not just transcript chunks)."
        ),
    },
  },
  async (args) => {
    const chunks = await getTranscriptChunks({
      recordingId: args.recording_id,
      speaker: args.speaker,
      includeSummary: args.include_summary,
    });
    const speakerSet = new Set(
      chunks.map((c) => c.speakers).filter((s) => s && s.length > 0)
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              recording_id: args.recording_id,
              chunk_count: chunks.length,
              speakers_detected: Array.from(speakerSet),
              chunks,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const UNKNOWN_SPEAKER_NOTE = `
Note on speaker attribution: many transcript chunks show \`Unknown\` as the
speaker because Fathom did not attribute them. When quoting, always list the
full participants array so the reader can reason about who likely said what,
and avoid confident claims of the form "X said Y" unless the speaker is
explicitly named in the chunk. Prefer meeting summaries (which Fathom
attributes more reliably) over raw transcript for attribution-sensitive
statements.`.trim();

server.registerPrompt(
  "client_persona",
  {
    title: "Client Persona",
    description:
      "Build a structured persona from every meeting with a company: pains, goals, objections, decision style, priorities, and verbatim quotes.",
    argsSchema: {
      company: z.string().describe("Company domain (e.g. acme.com)"),
      focus: z
        .string()
        .optional()
        .describe(
          "Optional angle (e.g. 'product decisions', 'pricing sensitivity')"
        ),
    },
  },
  ({ company, focus }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Build a detailed client persona for the company **${company}**${focus ? ` with a focus on: ${focus}` : ""}.

Use the fathom-kb tools in this order:

1. \`find_company\` with query="${company}" to confirm the domain and get meeting/contact counts.
2. \`list_meetings\` with company="${company}" and limit=50 to enumerate the relationship over time.
3. \`semantic_search\` with company="${company}" and one query per persona dimension:
   - "pain points and frustrations"
   - "goals and desired outcomes"
   - "objections and concerns"
   - "decision-making style and stakeholders"
   - "priorities and current initiatives"
   ${focus ? `- "${focus}"` : ""}
   Use limit=5 per search.
4. For 2-3 of the most recent high-signal meetings, call \`get_meeting\` with include_summary=true.

Then produce a persona with these sections:

## ${company} -- Persona

**Relationship summary**: duration, volume, key contacts, last interaction.

**Who they are**: roles, size, domain, what they do.

**Pains**: 3-5 concrete pains with recording_id + date citations.

**Goals**: what they're trying to accomplish, in their own words where possible.

**Objections & concerns**: patterns of pushback, risk aversion, blockers.

**Decision style**: how they evaluate, who weighs in, cadence, commitment signals.

**Current priorities**: what's active right now (based on the most recent meetings).

**Verbatim quotes**: 3-5 short direct quotes, each tagged with the recording_id and date.

**Confidence flags**: anything you're unsure about, areas with thin evidence.

${UNKNOWN_SPEAKER_NOTE}

Every non-obvious claim must cite at least one recording_id.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "sales_coaching",
  {
    title: "Sales Coaching Review",
    description:
      "Coach a specific meeting: what went well, what to improve, objection handling, pacing, next steps.",
    argsSchema: {
      recording_id: z
        .string()
        .describe("Recording ID to review (as string, will be parsed to int)"),
      angle: z
        .string()
        .optional()
        .describe(
          "Optional focus (e.g. 'discovery quality', 'closing language')"
        ),
    },
  },
  ({ recording_id, angle }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Coach this meeting${angle ? ` with focus on: ${angle}` : ""}.

Steps:

1. \`get_meeting\` with recording_id=${recording_id} and include_summary=true to get participants, summary, and metadata.
2. \`semantic_search\` with query="objections, concerns, pushback" limit=5, scoped by date_from/date_to set to this meeting's date to pull the relevant transcript chunks.
3. \`semantic_search\` with query="commitments, next steps, close" limit=5 for the same date range.
4. If the meeting is external (\`meeting_type: one_or_more_external\`), also \`semantic_search\` with query="discovery questions, understanding the problem" limit=5.

Then produce the review:

## Coaching review -- [title] ([date])

**Context**: participants, duration, meeting_type, stated purpose.

**What went well** (3-5 specific moments, with timestamps from start_timestamp).

**What to improve** (3-5 specific moments, with timestamps). For each, quote the actual language and propose a concrete rephrasing.

**Objection handling**: for each objection raised, note: the trigger, the response, and whether it was resolved or deferred.

**Pacing & structure**: where did time go, was there enough discovery, was the close rushed or natural.

**Action items surfaced**: commitments made by each side.

**Follow-up recommendation**: the single next best action.

${UNKNOWN_SPEAKER_NOTE}

Every observation must reference a timestamp or at minimum the meeting section (opening, discovery, pitch, close).`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "content_from_meetings",
  {
    title: "Content from Meetings",
    description:
      "Mine recurring themes, anecdotes, and quotable moments across meetings to seed blog posts, LinkedIn, or newsletter content.",
    argsSchema: {
      topic: z
        .string()
        .describe("Topic or question to mine (e.g. 'AI adoption in SMBs')"),
      audience: z
        .string()
        .optional()
        .describe("Target audience (e.g. 'consultants', 'founders')"),
      format: z
        .string()
        .optional()
        .describe("Output format (e.g. 'LinkedIn post', 'newsletter'). Default: flexible outline."),
    },
  },
  ({ topic, audience, format }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Mine the knowledge base for content on: **${topic}**${audience ? ` for ${audience}` : ""}${format ? ` in the form of a ${format}` : ""}.

Steps:

1. \`keyword_search\` with the 2-3 most precise terms for the topic (limit=10) to catch exact-term hits.
2. \`semantic_search\` with 3 differently-phrased queries around the topic (limit=6 each) to surface conceptually related content.
3. \`build_context\` with your strongest query (limit=8) to get a consolidated markdown block.

Synthesize:

## Content seed -- ${topic}

**Thesis**: one sentence, sharp, defensible from the evidence.

**Recurring themes** (3-5): for each, a one-line claim + 1-2 supporting quotes (with recording_id + date).

**Strongest anecdotes** (2-3): short story-shaped moments that illustrate the thesis. Include speaker context and enough setup to land.

**Contrarian or surprising angles**: anything in the data that cuts against the common narrative.

**Pull-quotes**: 5 short, punchy direct quotes suitable for social, each tagged with recording_id.

${format ? `**Draft**: one draft ${format} (${audience ? `targeted at ${audience}` : "tone: grounded, specific, no fluff"}) that uses the themes and anecdotes above.` : `**Suggested angles** (3): each with a headline, target format, and a one-paragraph outline.`}

${UNKNOWN_SPEAKER_NOTE}

Do not invent quotes. If a moment isn't strong enough, leave it out rather than paraphrase into a quote.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "account_prep",
  {
    title: "Account Prep Briefing",
    description:
      "Pre-meeting briefing for an upcoming call: recent history, open action items, unresolved concerns, recommended agenda.",
    argsSchema: {
      company: z.string().optional().describe("Company domain"),
      person: z.string().optional().describe("Person name or email"),
      lookback_days: z
        .string()
        .optional()
        .describe("How many days of history to consider. Default: 90"),
    },
  },
  ({ company, person, lookback_days }) => {
    const days = parseInt(lookback_days ?? "90", 10);
    const scope = company
      ? `company="${company}"`
      : person
        ? `person="${person}"`
        : "(no scope provided)";
    const scopeLabel = company ?? person ?? "UNKNOWN";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Prepare me for my next meeting with **${scopeLabel}**.

Scope is ${scope}. Look back ${days} days.

Steps:

1. ${company ? `\`find_company\` with query="${company}"` : person ? `\`find_person\` with query="${person}"` : "Ask me which account/person first."}
2. \`list_meetings\` ${company ? `with company="${company}"` : person ? `with person="${person}"` : ""} limit=15 to get recent interactions.
3. For the 3 most recent meetings, \`get_meeting\` with include_summary=true.
4. \`semantic_search\` ${company ? `with company="${company}"` : person ? `with person="${person}"` : ""} across:
   - "open action items and commitments"
   - "unresolved concerns or blockers"
   - "pending decisions or approvals"
   Each with limit=5.

Then produce the brief:

## Account brief -- ${scopeLabel}

**Relationship state**: total meetings, last contact, cadence.

**What we've discussed recently**: 3-5 bullets covering the last 30 days.

**Open action items**: commitments from either side that don't appear completed. Cite recording_id for each.

**Unresolved concerns**: blockers, objections, or questions the contact has raised that haven't been answered.

**Active threads**: what they seem to care about right now, what's moving.

**Recommended agenda** for the upcoming call (5-7 bullets, sequenced).

**Landmines**: anything to NOT bring up, or tread carefully around.

${UNKNOWN_SPEAKER_NOTE}`,
          },
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

// The fathom-research methodology as an MCP resource. Read on each request so
// edits to SKILL.md are picked up without restarting the server. The trigger
// language in the description mirrors the skill's frontmatter so MCP clients
// that surface resources to the model can match on the same cues that
// Cursor's native skill discovery uses.
server.registerResource(
  "fathom-research-skill",
  "skill://fathom-research",
  {
    title: "Fathom Research Skill",
    description:
      "Methodology for orchestrating deep research over the fathom-kb knowledge base. Defines Triangulation, Attribution, Temporal, Roleplay, and Checkpoint disciplines. Read this BEFORE doing multi-step research over meeting transcripts. Relevant when analyzing client meetings, sales calls, building personas, RAG over transcripts, or any 'fathom', 'meetings', 'transcripts', 'call review', 'client analysis' work.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const text = readFileSync(FATHOM_RESEARCH_SKILL_PATH, "utf-8");
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("fathom-kb MCP server ready (stdio)");
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
