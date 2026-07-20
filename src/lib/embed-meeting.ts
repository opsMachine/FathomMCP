import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Meeting } from "./types.js";
import { chunksForMeeting, type Chunk } from "./chunk.js";
import { embedBatch } from "./embed-model.js";
import {
  openVectorDb,
  openOrCreateTable,
  type VectorRow,
} from "./vectors.js";

export const BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE ?? "1");
export const FLUSH_EVERY = Number(process.env.EMBED_FLUSH_EVERY ?? "16");

export async function existingIdsForMeeting(
  table: Awaited<ReturnType<typeof openOrCreateTable>>,
  recordingId: number
): Promise<Set<string>> {
  const rows = (await table
    .query()
    .where(`recording_id = ${recordingId}`)
    .select(["id"])
    .toArray()) as Array<{ id?: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    if (row?.id) ids.add(row.id);
  }
  return ids;
}

export async function embedMeetingFile(
  rawPath: string,
  table: Awaited<ReturnType<typeof openOrCreateTable>>
): Promise<{ embedded: number; skipped: number }> {
  const meeting: Meeting = JSON.parse(readFileSync(rawPath, "utf-8"));
  const meetingChunks = chunksForMeeting(meeting);
  const existingIds = await existingIdsForMeeting(
    table,
    meeting.recording_id
  );

  const chunks = meetingChunks.filter((c) => !existingIds.has(c.id));
  const skipped = meetingChunks.length - chunks.length;
  if (chunks.length === 0) return { embedded: 0, skipped };

  let embedded = 0;
  let pending: VectorRow[] = [];

  const flushPending = async () => {
    if (pending.length === 0) return;
    await table.add(pending as unknown as Record<string, unknown>[]);
    pending = [];
  };

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(batch.map((c) => c.text));

    for (let j = 0; j < batch.length; j++) {
      pending.push(chunkToRow(batch[j], vectors[j]));
    }

    embedded += batch.length;
    if (pending.length >= FLUSH_EVERY) await flushPending();
  }

  await flushPending();
  return { embedded, skipped };
}

function chunkToRow(chunk: Chunk, vector: number[]): VectorRow {
  return {
    id: chunk.id,
    recording_id: chunk.recording_id,
    kind: chunk.kind,
    chunk_index: chunk.chunk_index,
    text: chunk.text,
    start_timestamp: chunk.start_timestamp ?? "",
    end_timestamp: chunk.end_timestamp ?? "",
    speakers: chunk.speakers,
    meeting_date: chunk.meeting_date,
    meeting_title: chunk.meeting_title,
    participants: chunk.participants,
    vector,
  };
}

export async function openEmbedTable(fresh: boolean) {
  const db = await openVectorDb();
  if (fresh) {
    const names = await db.tableNames();
    if (names.includes("chunks")) {
      console.log("--fresh: dropping existing chunks table");
      await db.dropTable("chunks");
    }
  }
  return openOrCreateTable(db);
}

export function listRawMeetingFiles(rawDir: string): string[] {
  return readdirSync(rawDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function meetingPath(rawDir: string, file: string): string {
  return join(rawDir, file);
}
