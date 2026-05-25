import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const SERVER_PATH = join(import.meta.dirname, "mcp-server.ts");

interface ToolContent {
  type: string;
  text?: string;
}
interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

async function main() {
  // StdioClientTransport only inherits a hardcoded "safe" env list
  // (HOME / PATH / SHELL / etc.). Forward the FathomMCP-specific vars
  // explicitly so the spawned server resolves the same data root as the
  // shell that launched the test — otherwise paths.ts falls back to the
  // FathomMCP repo root and writes an empty corpus there.
  const forwardedEnv: Record<string, string> = {};
  for (const key of ["FATHOM_DATA_ROOT", "FATHOM_API_KEY"]) {
    const value = process.env[key];
    if (value) forwardedEnv[key] = value;
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "tsx", SERVER_PATH],
    env: forwardedEnv,
  });
  const client = new Client(
    { name: "smoketest", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  const tests: Array<{
    name: string;
    args: Record<string, unknown>;
    check: (r: ToolResult) => string | null;
  }> = [
    {
      name: "list_meetings",
      args: { limit: 3 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (!Array.isArray(data.meetings) || data.meetings.length === 0)
          return "no meetings returned";
        if (!data.meetings[0].recording_id) return "missing recording_id";
        return null;
      },
    },
    {
      name: "list_meetings",
      args: { person: "jalyn", limit: 5 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        return data.count > 0 ? null : "expected >0 meetings with jalyn";
      },
    },
    {
      name: "find_person",
      args: { query: "jalyn", limit: 2 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        return data.people?.[0]?.email?.includes("jalyn")
          ? null
          : "no jalyn found";
      },
    },
    {
      name: "find_company",
      args: { query: "alistova", limit: 2 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        return data.companies?.[0]?.domain === "alistova.com"
          ? null
          : "alistova.com not found";
      },
    },
    {
      name: "keyword_search",
      args: { query: "ai adoption", limit: 2 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        return data.count > 0 ? null : "no FTS hits for 'ai adoption'";
      },
    },
    {
      name: "semantic_search",
      args: { query: "pricing objections", limit: 2 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (!data.hits?.length) return "no semantic hits";
        if (typeof data.hits[0].distance !== "number")
          return "missing distance score";
        return null;
      },
    },
    {
      name: "semantic_search",
      args: { query: "pricing", person: "jalyn", limit: 2 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        return data.hits?.length
          ? null
          : "no scoped semantic hits for jalyn+pricing";
      },
    },
    {
      name: "build_context",
      args: { query: "onboarding", limit: 2 },
      check: (r) => {
        const text = (r.content[0].text as string) ?? "";
        return text.startsWith("# Context for:") ? null : "unexpected format";
      },
    },
    {
      name: "get_meeting",
      args: { recording_id: 138356277, include_summary: false },
      check: (r) => {
        if (r.isError) return "get_meeting returned isError";
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (!Array.isArray(data.participants)) return "missing participants";
        return null;
      },
    },
    {
      name: "semantic_search",
      args: { query: "pricing", limit: 6, min_distinct_meetings: 3 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (!data.hits?.length) return "no hits";
        if (typeof data.distinct_meetings !== "number")
          return "missing distinct_meetings field";
        if (data.distinct_meetings < Math.min(3, data.hits.length))
          return `expected >=3 distinct meetings, got ${data.distinct_meetings}`;
        return null;
      },
    },
    {
      name: "get_entity_timeline",
      args: { entity: "alistova.com", entity_type: "company", limit: 5 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (!Array.isArray(data.timeline)) return "missing timeline array";
        if (data.count === 0) return "no timeline entries";
        const dates = data.timeline.map((e: { date: string }) => e.date);
        for (let i = 1; i < dates.length; i++) {
          if (dates[i] < dates[i - 1])
            return `timeline not chronological: ${dates[i - 1]} -> ${dates[i]}`;
        }
        return null;
      },
    },
    {
      name: "get_project_status",
      args: { project: "onboarding" },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (!data.status) return "missing status";
        if (!["active", "paused", "canceled", "completed", "unknown"].includes(data.status))
          return `unexpected status: ${data.status}`;
        if (!Array.isArray(data.history)) return "missing history array";
        return null;
      },
    },
    {
      name: "verify_claim",
      args: { claim: "pricing is a concern", limit: 3 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        for (const key of ["supporting", "contradicting", "unclear", "method", "note"]) {
          if (!(key in data)) return `missing key: ${key}`;
        }
        if (!Array.isArray(data.supporting)) return "supporting not an array";
        return null;
      },
    },
    {
      name: "get_transcript",
      args: { recording_id: 138356277 },
      check: (r) => {
        const data = JSON.parse((r.content[0].text as string) ?? "{}");
        if (typeof data.chunk_count !== "number") return "missing chunk_count";
        if (!Array.isArray(data.chunks)) return "missing chunks array";
        if (!Array.isArray(data.speakers_detected))
          return "missing speakers_detected array";
        // Verify ordering: each start_timestamp should be >= previous.
        for (let i = 1; i < data.chunks.length; i++) {
          const prev = data.chunks[i - 1].start_timestamp;
          const cur = data.chunks[i].start_timestamp;
          if (prev && cur && prev > cur && cur.length > 0) {
            // tolerate format noise; only flag lexicographic regressions on HH:MM:SS
            if (prev.length === cur.length) {
              return `chunks not ordered: ${prev} -> ${cur}`;
            }
          }
        }
        return null;
      },
    },
  ];

  const { tools } = await client.listTools();
  console.log(`Tools available: ${tools.map((t) => t.name).join(", ")}`);

  const { prompts } = await client.listPrompts();
  console.log(`Prompts available: ${prompts.map((p) => p.name).join(", ")}`);

  const { resources } = await client.listResources();
  console.log(
    `Resources available: ${resources.map((r) => r.uri).join(", ")}\n`
  );

  let pass = 0;
  let fail = 0;

  try {
    const skillRes = await client.readResource({
      uri: "skill://fathom-research",
    });
    const text =
      "text" in skillRes.contents[0]
        ? (skillRes.contents[0].text as string)
        : "";
    if (text.includes("Triangulation protocol") && text.includes("Attribution discipline")) {
      console.log("PASS  resource:skill://fathom-research");
      pass++;
    } else {
      console.log(
        "FAIL  resource:skill://fathom-research -- expected Triangulation + Attribution sections"
      );
      fail++;
    }
  } catch (err) {
    console.log(
      `ERROR resource:skill://fathom-research -> ${(err as Error).message}`
    );
    fail++;
  }

  const promptTests: Array<{
    name: string;
    args: Record<string, string>;
    expectContains: string;
  }> = [
    {
      name: "client_persona",
      args: { company: "alistova.com" },
      expectContains: "alistova.com",
    },
    {
      name: "sales_coaching",
      args: { recording_id: "138356277" },
      expectContains: "138356277",
    },
    {
      name: "content_from_meetings",
      args: { topic: "AI adoption" },
      expectContains: "AI adoption",
    },
    {
      name: "account_prep",
      args: { company: "alistova.com", lookback_days: "90" },
      expectContains: "alistova.com",
    },
  ];

  for (const p of promptTests) {
    try {
      const result = await client.getPrompt({
        name: p.name,
        arguments: p.args,
      });
      const text = result.messages
        .map((m) => ("text" in m.content ? m.content.text : ""))
        .join("\n");
      if (text.includes(p.expectContains)) {
        console.log(`PASS  prompt:${p.name}(${JSON.stringify(p.args)})`);
        pass++;
      } else {
        console.log(
          `FAIL  prompt:${p.name} -- expected text to contain "${p.expectContains}"`
        );
        fail++;
      }
    } catch (err) {
      console.log(
        `ERROR prompt:${p.name}(${JSON.stringify(p.args)}) -> ${(err as Error).message}`
      );
      fail++;
    }
  }

  for (const t of tests) {
    try {
      const result = (await client.callTool({
        name: t.name,
        arguments: t.args,
      })) as ToolResult;
      const err = t.check(result);
      if (err) {
        console.log(`FAIL  ${t.name}(${JSON.stringify(t.args)}) -> ${err}`);
        fail++;
      } else {
        console.log(`PASS  ${t.name}(${JSON.stringify(t.args)})`);
        pass++;
      }
    } catch (err) {
      console.log(
        `ERROR ${t.name}(${JSON.stringify(t.args)}) -> ${(err as Error).message}`
      );
      fail++;
    }
  }

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
  await client.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
