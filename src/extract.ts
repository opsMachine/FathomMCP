import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFathomClient } from "./lib/fathom-api.js";
import type { Meeting, SyncState } from "./lib/types.js";
import { RAW_DIR, SYNC_STATE_PATH } from "./lib/paths.js";

config();

const API_KEY = process.env.FATHOM_API_KEY;
if (!API_KEY) {
  console.error(
    "Missing FATHOM_API_KEY in .env — see .env.example for direct and OneCLI modes"
  );
  process.exit(1);
}
if (API_KEY === "Fathom" && !process.env.HTTP_PROXY) {
  console.warn(
    "Warning: FATHOM_API_KEY=Fathom (OneCLI placeholder) but HTTP_PROXY is not set. " +
    "Use npm run extract:onecli or set proxy env vars. Continuing anyway."
  );
}

mkdirSync(RAW_DIR, { recursive: true });

function loadSyncState(): SyncState {
  if (existsSync(SYNC_STATE_PATH)) {
    return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
  }
  return {
    last_sync_at: null,
    last_cursor: null,
    downloaded_ids: [],
    total_downloaded: 0,
  };
}

function saveSyncState(state: SyncState): void {
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

function saveMeeting(meeting: Meeting): void {
  const filePath = join(RAW_DIR, `${meeting.recording_id}.json`);
  writeFileSync(filePath, JSON.stringify(meeting, null, 2));
}

async function main() {
  const client = createFathomClient(API_KEY!);
  const state = loadSyncState();
  const existingIds = new Set(state.downloaded_ids);

  const isIncremental = !!state.last_sync_at;
  const syncStartedAt = new Date().toISOString();

  console.log(
    isIncremental
      ? `Incremental sync (meetings after ${state.last_sync_at})`
      : "Full sync (all meetings)"
  );

  let cursor: string | undefined;
  let pageNum = 0;
  let newMeetings = 0;
  let skipped = 0;

  do {
    pageNum++;
    process.stdout.write(`  Page ${pageNum}...`);

    const response = await client.listMeetings({
      cursor,
      createdAfter: isIncremental ? state.last_sync_at! : undefined,
      includeTranscript: true,
      includeSummary: true,
    });

    for (const meeting of response.items) {
      if (existingIds.has(meeting.recording_id)) {
        skipped++;
        continue;
      }

      saveMeeting(meeting);
      existingIds.add(meeting.recording_id);
      newMeetings++;
    }

    console.log(
      ` ${response.items.length} meetings (${newMeetings} new, ${skipped} skipped)`
    );

    cursor = response.next_cursor ?? undefined;

    state.downloaded_ids = [...existingIds];
    state.total_downloaded = existingIds.size;
    state.last_cursor = cursor ?? null;
    saveSyncState(state);
  } while (cursor);

  state.last_sync_at = syncStartedAt;
  state.last_cursor = null;
  saveSyncState(state);

  console.log(
    `\nDone. ${newMeetings} new meetings downloaded. ${state.total_downloaded} total on disk.`
  );
}

main().catch((err) => {
  console.error("Extraction failed:", err);
  process.exit(1);
});
