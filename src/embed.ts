import "./lib/configure-onnx.js";

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  embedMeetingFile,
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

function workerFileArg(): string | null {
  const idx = process.argv.indexOf("--worker");
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function runWorker(file: string): Promise<void> {
  const table = await openEmbedTable(false);
  const path = meetingPath(RAW_DIR, file);
  const { embedded, skipped } = await embedMeetingFile(path, table);
  if (embedded > 0) {
    console.log(`  ${file}: embedded ${embedded}, skipped ${skipped}`);
  }
}

async function runInProcess(): Promise<void> {
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`Found ${files.length} meetings (in-process)`);
  const table = await openEmbedTable(FRESH);

  const start = Date.now();
  let totalEmbedded = 0;
  let totalSkipped = 0;
  let meetingsDone = 0;

  for (const file of files) {
    const { embedded, skipped } = await embedMeetingFile(
      meetingPath(RAW_DIR, file),
      table
    );
    totalEmbedded += embedded;
    totalSkipped += skipped;
    meetingsDone++;

    if (embedded > 0) {
      console.log(`  ${file}: embedded ${embedded}, skipped ${skipped}`);
    }

    if (meetingsDone % 50 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.log(
        `  progress ${meetingsDone}/${files.length} meetings (${totalEmbedded} chunks, ${elapsed.toFixed(0)}s)`
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

  console.log(
    `Found ${files.length} meetings (isolated — one subprocess per meeting)`
  );

  const start = Date.now();
  let failures = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const code = await spawnWorker(file);
    if (code !== 0) {
      failures++;
      console.error(`  ${file}: worker exited ${code}`);
    }

    if ((i + 1) % 25 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.log(
        `  progress ${i + 1}/${files.length} meetings (${elapsed.toFixed(0)}s)`
      );
    }
  }

  if (failures > 0) {
    console.error(`\nFinished with ${failures} failed meeting(s). Re-run to resume.`);
    process.exit(1);
  }

  console.log(`\nDone. ${files.length} meetings processed.`);
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
