---
name: fathom-research
description: >-
  Orchestrate deep research across Fathom meeting transcripts. Use when the user
  asks to analyze client meetings, review sales calls, research a topic across
  meetings, build client personas, export transcripts for RAG, or says 'fathom',
  'meetings', 'transcripts', 'call review', 'client analysis'.
---

<!-- Last updated: 2026-04-16 -->

# Fathom Meeting Research

Orchestrate multi-step research workflows over the local Fathom knowledge base (`fathom-kb` MCP server). The store is a SQLite + LanceDB index built from Fathom exports; all tools are read-only.

**The core risk of this skill is not missing data. It is producing confident synthesis from a single slice of retrieval.** The discipline sections below (Triangulation, Attribution, Temporal, Roleplay, Checkpoint) exist because the default failure mode is pattern-matching across meetings and silently dropping speaker, time, and source into a plausible-sounding narrative. Follow them.

## Available MCP tools (`fathom-kb`)

| Tool | Purpose |
|------|---------|
| `list_meetings` | List/filter meetings by date, person, company, meeting_type, relationships, call_types |
| `get_meeting` | Full metadata + summary + participants for one `recording_id` |
| `find_person` | Search participants by name/email substring |
| `find_company` | Search companies by domain substring |
| `list_people_by_relationship` | Enumerate every person with a given relationship tag |
| `keyword_search` | FTS5 over meeting titles and summaries (use for precise terms, names, acronyms) |
| `semantic_search` | Vector search across transcript chunks and summaries (use for conceptual questions). Supports `min_distinct_meetings` to diversify. |
| `get_entity_timeline` | Chronologically-ordered mentions of a person/company/project/topic |
| `get_project_status` | Latest known state of a named project/deal/initiative, with history |
| `verify_claim` | Scan for supporting, contradicting, and unclear evidence for a claim |
| `get_transcript` | All indexed transcript chunks for one `recording_id`, ordered by timestamp (optional `speaker` filter — limited until speaker attribution is improved) |
| `build_context` | Run a semantic search and return a markdown-formatted context block |

Available prompts: `client_persona`, `sales_coaching`, `content_from_meetings`, `account_prep`.

## Core discipline

Most failures of this skill are not retrieval failures — they are synthesis failures on top of thin retrieval. The five sections below are non-optional.

### A1. Triangulation protocol

Any claim about **user state, narrative, or a recurring pattern** must pass through:

- At least 2 of: `semantic_search`, `keyword_search`, `find_person` / `find_company`, `list_meetings`, `get_entity_timeline`.
- Results from **at least 3 distinct meetings** (pass `min_distinct_meetings: 3` on `semantic_search`), or explicitly note "only 1 meeting found" in the output.
- A temporal bracket: is this from the last 30 / 90 / 365 days? State it.

A single `semantic_search` call is only sufficient for *"find me the meeting where X happened"*-style retrievals. It is **not** sufficient for *"what does the user think about X"*, *"is this deal moving"*, or *"what has the user said recently about Y"*. Those require triangulation.

If a pattern shows up in 1 meeting, it is an anecdote. If it shows up in 3+, it is a pattern.

### A2. Attribution discipline

- Every quote must cite **speaker + meeting title + date**.
- If the transcript chunk shows `Unknown:` or `Unknown` as the speaker, do **not** attribute the line to anyone. Either:
  - Re-derive the speaker from context (e.g., two-party call where the other name is explicit), **or**
  - Drop the quote entirely.
- When describing someone's beliefs, positions, or narrative, strictly separate three categories:
  - **"Things they said"** — direct quote with citation
  - **"Things said to them"** — another participant's words, never recast as theirs
  - **"Inferences"** — explicitly labeled as inference, not fact

Meeting titles and meeting summaries are more reliable for attribution than raw transcript chunks. Prefer `get_meeting(include_summary=true)` when attribution matters and the transcript is ambiguous.

The classic failure mode: a coach says to a user "after six years of struggling you should…" — and later a search surfaces this quote, and it gets recast as something the user said about themselves. Don't do this.

### A3. Temporal resolution

- `meeting_date` = when the conversation happened.
- `event_date` = when the thing being discussed happened (often earlier, sometimes later/planned).
- **Status claims** ("the project is X", "the deal is Y", "they are working on Z") must be based on the **most recent meeting where the topic appears**, not whichever meeting surfaced first in a search.
- For any ongoing entity (project, deal, relationship), run a **"latest mention" query** before stating status. Use `get_project_status(project)` for named projects, or `get_entity_timeline(entity, ...)` and read the last row.
- A summary line written on date D may describe an event that happened weeks earlier. Do not treat summary recency as event recency.

### A4. Roleplay guardrails

When the user asks this skill to "be me", simulate their voice, or respond as them:

- Every **factual claim** about the user's past requires a citation.
- Every **emotional or positional** claim requires a grounded quote or an explicit "I'm inferring this from X."
- When the user corrects the agent, the first response is a **targeted re-search** (narrower query, more specific time window, direct `get_meeting` on the cited source), not a quick narrative reframe.
- Never attribute another participant's stance or narrative to the user just because it appeared in a meeting they were in.
- If you catch yourself generating dialogue in the user's voice without a source for the underlying claim, stop and search first.

### A5. Checkpoint before synthesis

After any research burst of 3+ tool calls, **before** producing the final answer, produce an internal three-column note:

- **Known** — cited, attributed, dated.
- **Inferred** — plausible extrapolation from known.
- **Unknown / would want to verify** — gaps.

Only synthesize once this is clear. **If "Inferred" is larger than "Known", do more searching.** For any claim pulled up to the synthesis that lives in "Inferred" rather than "Known", either demote it ("likely…", "the pattern suggests…") or drop it.

For high-stakes claims (project status, deal status, user position on a topic), pass the claim through `verify_claim` before asserting it.

---

## Workflow 1: Client / company analysis

1. `find_company(query="acme")` to confirm the domain.
2. `list_meetings(company="acme.com", limit=50)` for the relationship timeline.
3. `get_entity_timeline(entity="acme", entity_type="company")` for a chronological snippet-level view.
4. `semantic_search` with `company="acme.com"` + `min_distinct_meetings=3` for each persona dimension:
   - "pain points and frustrations"
   - "goals and desired outcomes"
   - "objections and concerns"
   - "decision-making style"
   - "current priorities"
5. For the 2–3 highest-signal meetings, `get_meeting(recording_id, include_summary=true)`.
6. Apply the checkpoint (A5) before writing the profile.

Use the `client_persona` prompt for a guided version.

## Workflow 2: Sales call coaching

1. `get_meeting(recording_id, include_summary=true)` — context.
2. `get_transcript(recording_id)` — full conversation ordered by timestamp.
3. Analyze:
   - **Talk ratio** — count speaker turns per speaker (skip `Unknown`).
   - **Question quality** — open vs. closed from the rep.
   - **Discovery depth** — pain, budget, timeline, decision process.
   - **Objection handling** — `semantic_search(query="objections concerns pushback", date_from=<meeting date>, date_to=<meeting date>)`.
   - **Commitments / close** — `semantic_search(query="commitments next steps", ...)`.
4. Output a structured review with timestamps and quotes. Follow A2 strictly — if a line is `Unknown`, don't attribute it.

Use the `sales_coaching` prompt for a guided version.

## Workflow 3: Topic / pattern research

When the user wants to investigate a topic across all meetings:

1. `keyword_search(query=<exact terms>, limit=15)` for precise hits (names, acronyms).
2. `semantic_search(query=<phrasing 1>, min_distinct_meetings=3, limit=10)` for conceptual hits. Run 2–3 differently-phrased queries.
3. `get_entity_timeline(entity=<topic>, entity_type="topic")` for chronological structure.
4. For top 3 meetings, `get_meeting(recording_id, include_summary=true)`.
5. Apply triangulation (A1), attribution (A2), temporal (A3), and checkpoint (A5).
6. If the synthesis will make a strong claim (e.g., "the user's view is X"), run `verify_claim(claim=<claim>)` before asserting.

Cite every finding as `[Meeting Title, YYYY-MM-DD](url)` with speaker where known.

## Workflow 4: Project / deal status

When the user asks "what's happening with project X" or "is the X deal still on":

1. `get_project_status(project="X")` — returns latest known status + history.
2. If status is `unknown`, fall back: `get_entity_timeline(entity="X", entity_type="project")` and read the last rows.
3. `get_meeting(recording_id)` on the most recent mention to confirm.
4. **Never** rely on an older meeting for status when a newer one exists. This is the Karim-cancellation class of error.

## Workflow 5: Account prep

1. `find_company` or `find_person` to resolve the target.
2. `list_meetings(company=..., limit=15)` or `list_meetings(person=..., limit=15)`.
3. `get_meeting(include_summary=true)` for the 3 most recent.
4. `semantic_search` with `company` / `person` filter + `min_distinct_meetings=3` across:
   - "open action items commitments"
   - "unresolved concerns blockers"
   - "pending decisions approvals"
5. For any ongoing project mentioned, call `get_project_status` to confirm current state.
6. Apply the checkpoint (A5). Output brief.

Use the `account_prep` prompt for a guided version.

## Workflow 6: Content mining

1. `keyword_search` with 2–3 precise terms (limit=10).
2. `semantic_search` with 3 different phrasings (limit=6 each, `min_distinct_meetings=3`).
3. `build_context(query=<strongest>, limit=8)` for a consolidated markdown block.
4. Pull 3–5 short direct quotes — each with speaker (A2) and date.
5. Do not invent quotes. Paraphrase is labeled as paraphrase; only verbatim strings in quote marks.

Use the `content_from_meetings` prompt for a guided version.

---

## Query patterns

### When single-slice is enough
- "Find the meeting where we discussed the pricing change" — `semantic_search` or `keyword_search`, one call.
- "What did this meeting cover" — `get_meeting(include_summary=true)`, one call.
- "Who was in the X call" — `get_meeting`.

### When you must triangulate
- "What does the user think about X" — A1 applies.
- "Is deal X still active" — A3 + Workflow 4.
- "What has person X been saying about Y" — `get_entity_timeline(entity="X", entity_type="person")` plus targeted `semantic_search` with `person="X"`.
- "Summarize my recent business thinking" — multiple queries across business-model, prospecting, pricing, ideal-client themes; `min_distinct_meetings=3` on each; checkpoint before output.

### Query construction
- `semantic_search` queries should be **natural-language phrases**, not keyword bags. "Why my pipeline is slow" > "pipeline slow".
- `keyword_search` uses FTS5 syntax: `AND`, `OR`, `NOT`, quoted phrases, parens.
- If nothing returns, relax the query (drop qualifiers), then widen the date range, then try a different phrasing — in that order.

## Known data-quality caveats

- Many transcript chunks show `Unknown` as the speaker. This is an upstream data issue. Respect A2 — do not invent attribution. Summaries (`get_meeting(include_summary=true)`) are more reliable than raw chunks for who-said-what.
- Entity resolution (e.g., "Karim" vs. "Kareem" vs. full name) is not always clean. For any search where the exact name matters, try multiple spellings.
- Project/deal status is not a first-class field — `get_project_status` infers from mentions. Verify with a direct `get_meeting` on the most recent hit before asserting.
