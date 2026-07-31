import "./lib/configure-onnx.js";

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  embedMeetingFile,
  filterMeetingsNeedingEmbed,
  loadExistingChunkIds,
  meetingPath,
  openEmbedTable,
} from "./lib/embed-meeting.js";
import { RAW_DIR, DATA_ROOT } from "./lib/paths.js";

const FRESH =
  process.argv.includes("--fresh") || process.env.FRESH === "1";
const ISOLATED =
  process.argv.includes("--isolated") ||
  process.env.EMBED_ISOLATED === "1";
const WORKER = process.argv.includes("--worker");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXISTING_IDS_CACHE = join(DATA_ROOT, "data", ".embed-existing-ids.json");

function workerFileArg(): string | null {
  const idx = process.argv.indexOf("--worker");
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function loadCachedExistingIds(): Set<string> | null {
  if (!existsSync(EXISTING_IDS_CACHE)) return null;
  try {
    const ids = JSON.parse(readFileSync(EXISTING_IDS_CACHE, "utf-8")) as string[];
    return new Set(ids);
  } catch {
    return null;
  }
}

function writeCachedExistingIds(ids: Set<string>): void {
  writeFileSync(EXISTING_IDS_CACHE, JSON.stringify([...ids]));
}

async function prepareEmbedRun(
  files: string[]
): Promise<{
  table: Awaited<ReturnType<typeof openEmbedTable>>;
  existingIds: Set<string>;
  pending: string[];
}> {
  const table = await openEmbedTable(FRESH);
  const existingIds = FRESH ? new Set<string>() : await loadExistingChunkIds(table);
  const pending = FRESH
    ? files
    : filterMeetingsNeedingEmbed(RAW_DIR, files, existingIds);

  if (!FRESH && existingIds.size > 0) {
    console.log(
      `Found ${existingIds.size} existing vectors — ${pending.length} meeting(s) need embedding (${files.length - pending.length} already complete)`
    );
  } else {
    console.log(`Found ${files.length} meetings, ${pending.length} to embed`);
  }

  return { table, existingIds, pending };
}

async function runWorker(file: string): Promise<void> {
  const table = await openEmbedTable(false);
  const cached = loadCachedExistingIds();
  const existingIds =
    cached ?? (await loadExistingChunkIds(table));
  const path = meetingPath(RAW_DIR, file);
  const { embedded, skipped } = await embedMeetingFile(path, table, existingIds);
  if (embedded > 0) {
    console.log(`  ${file}: embedded ${embedded}, skipped ${skipped}`);
  }
}

async function runInProcess(): Promise<void> {
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`Scanning ${files.length} meetings (in-process)`);
  const { table, existingIds, pending } = await prepareEmbedRun(files);

  if (pending.length === 0) {
    console.log(`\nNothing to do. ${existingIds.size} chunks already stored.`);
    return;
  }

  const start = Date.now();
  let totalEmbedded = 0;
  let totalSkipped = 0;

  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    const { embedded, skipped } = await embedMeetingFile(
      meetingPath(RAW_DIR, file),
      table,
      existingIds
    );
    totalEmbedded += embedded;
    totalSkipped += skipped;

    if (embedded > 0) {
      console.log(`  ${file}: embedded ${embedded}, skipped ${skipped}`);
    }

    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.log(
        `  progress ${i + 1}/${pending.length} pending meetings (${totalEmbedded} chunks, ${elapsed.toFixed(0)}s)`
      );
    }
  }

  if (totalEmbedded === 0) {
    console.log(`\nNothing to do. ${totalSkipped} chunks already stored.`);
    return;
  }

  console.log(
    `\nDone. embedded ${totalEmbedded} chunks, skipped ${totalSkipped} existing.`
  );
}

function spawnWorker(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const script = join(REPO_ROOT, "src/embed.ts");
    const child = spawn(
      "npx",
      ["tsx", script, "--worker", file],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          FATHOM_DATA_ROOT: DATA_ROOT,
        },
        stdio: "inherit",
      }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`worker ${file} killed by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function runIsolated(): Promise<void> {
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (FRESH) {
    await openEmbedTable(true);
  }

  console.log(`Scanning ${files.length} meetings (isolated — one subprocess per pending meeting)`);
  const { existingIds, pending } = await prepareEmbedRun(files);

  if (pending.length === 0) {
    console.log(`\nNothing to do. ${existingIds.size} chunks already stored.`);
    return;
  }

  writeCachedExistingIds(existingIds);

  const start = Date.now();
  let failures = 0;

  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    const code = await spawnWorker(file);
    if (code !== 0) {
      failures++;
      console.error(`  ${file}: worker exited ${code}`);
    }

    if ((i + 1) % 25 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.log(
        `  progress ${i + 1}/${pending.length} pending meetings (${elapsed.toFixed(0)}s)`
      );
    }
  }

  try {
    unlinkSync(EXISTING_IDS_CACHE);
  } catch {
    // cache is best-effort
  }

  if (failures > 0) {
    console.error(`\nFinished with ${failures} failed meeting(s). Re-run to resume.`);
    process.exit(1);
  }

  console.log(`\nDone. ${pending.length} meetings processed.`);
}

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.error("No data/raw/. Run: npm run extract && npm run transform");
    process.exit(1);
  }

  if (WORKER) {
    const file = workerFileArg();
    if (!file) {
      console.error("Usage: tsx src/embed.ts --worker <file.json>");
      process.exit(1);
    }
    await runWorker(file);
    return;
  }

  if (ISOLATED) {
    await runIsolated();
    return;
  }

  await runInProcess();
}

main().catch((err) => {
  console.error("Embed failed:", err);
  process.exit(1);
});
