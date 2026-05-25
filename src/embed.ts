import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Meeting } from "./lib/types.js";
import { chunksForMeeting, type Chunk } from "./lib/chunk.js";
import { embedBatch } from "./lib/embed-model.js";
import { openVectorDb, openOrCreateTable, type VectorRow } from "./lib/vectors.js";
import { RAW_DIR } from "./lib/paths.js";

const BATCH_SIZE = 32;
const FLUSH_EVERY = 256;

// Pass --fresh (or FRESH=1) to drop the table and re-embed everything.
// Default behavior is resumable: skip chunks whose id already exists.
const FRESH =
  process.argv.includes("--fresh") || process.env.FRESH === "1";

async function loadExistingIds(
  table: Awaited<ReturnType<typeof openOrCreateTable>>
): Promise<Set<string>> {
  const existing = new Set<string>();
  const count = await table.countRows();
  if (count === 0) return existing;

  const rows = await table.query().select(["id"]).toArray();
  for (const row of rows) {
    if (row && typeof row.id === "string") existing.add(row.id);
  }
  return existing;
}

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.error("No data/raw/. Run: npm run extract && npm run transform");
    process.exit(1);
  }

  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Loading ${files.length} meetings...`);

  const allChunks: Chunk[] = [];
  for (const file of files) {
    const meeting: Meeting = JSON.parse(
      readFileSync(join(RAW_DIR, file), "utf-8")
    );
    allChunks.push(...chunksForMeeting(meeting));
  }

  console.log(`Prepared ${allChunks.length} chunks total`);

  const db = await openVectorDb();

  if (FRESH) {
    const names = await db.tableNames();
    if (names.includes("chunks")) {
      console.log("--fresh: dropping existing chunks table");
      await db.dropTable("chunks");
    }
  }

  const table = await openOrCreateTable(db);

  // Resume: skip chunks already in the table.
  let chunks = allChunks;
  if (!FRESH) {
    const existingCount = await table.countRows();
    if (existingCount > 0) {
      console.log(
        `Found ${existingCount} existing vectors — resuming (use --fresh to rebuild)`
      );
      const existingIds = await loadExistingIds(table);
      chunks = allChunks.filter((c) => !existingIds.has(c.id));
      console.log(
        `  ${allChunks.length - chunks.length} already embedded, ${chunks.length} remaining`
      );
    }
  }

  if (chunks.length === 0) {
    const count = await table.countRows();
    console.log(`\nNothing to do. ${count} vectors already stored.`);
    return;
  }

  console.log(`Embedding ${chunks.length} chunks...`);

  const start = Date.now();
  let processed = 0;
  let pending: VectorRow[] = [];

  const flushPending = async () => {
    if (pending.length === 0) return;
    await table.add(pending as unknown as Record<string, unknown>[]);
    pending = [];
  };

  // Flush-on-exit so Ctrl+C keeps partial progress.
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    console.log(`\nReceived ${sig}, flushing ${pending.length} pending rows...`);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      if (interrupted) break;

      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      const vectors = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        pending.push({
          id: batch[j].id,
          recording_id: batch[j].recording_id,
          kind: batch[j].kind,
          chunk_index: batch[j].chunk_index,
          text: batch[j].text,
          start_timestamp: batch[j].start_timestamp ?? "",
          end_timestamp: batch[j].end_timestamp ?? "",
          speakers: batch[j].speakers,
          meeting_date: batch[j].meeting_date,
          meeting_title: batch[j].meeting_title,
          participants: batch[j].participants,
          vector: vectors[j],
        });
      }

      processed += batch.length;

      if (pending.length >= FLUSH_EVERY) {
        await flushPending();
      }

      if (processed % 256 === 0 || processed === chunks.length) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = processed / elapsed;
        const eta = (chunks.length - processed) / rate;
        console.log(
          `  ${processed}/${chunks.length} (${rate.toFixed(1)}/s, eta ${Math.round(eta)}s)`
        );
      }
    }
  } finally {
    await flushPending();
  }

  const count = await table.countRows();
  if (interrupted) {
    console.log(`\nInterrupted. ${count} vectors stored. Re-run to resume.`);
    process.exit(130);
  }
  console.log(`\nDone. ${count} vectors stored in data/vectors/`);
}

main().catch((err) => {
  console.error("Embed failed:", err);
  process.exit(1);
});
