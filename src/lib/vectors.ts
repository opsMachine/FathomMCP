import * as lancedb from "@lancedb/lancedb";
import {
  Schema,
  Field,
  Utf8,
  Int32,
  FixedSizeList,
  Float32,
} from "apache-arrow";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EMBED_DIM } from "./embed-model.js";
import { VECTORS_DIR } from "./paths.js";

export const VECTOR_DB_PATH = VECTORS_DIR;
export const TABLE_NAME = "chunks";

export interface VectorRow {
  id: string;
  recording_id: number;
  kind: string;
  chunk_index: number;
  text: string;
  start_timestamp: string;
  end_timestamp: string;
  speakers: string;
  meeting_date: string;
  meeting_title: string;
  participants: string;
  vector: number[];
}

const chunkSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("recording_id", new Int32(), false),
  new Field("kind", new Utf8(), false),
  new Field("chunk_index", new Int32(), false),
  new Field("text", new Utf8(), false),
  new Field("start_timestamp", new Utf8(), true),
  new Field("end_timestamp", new Utf8(), true),
  new Field("speakers", new Utf8(), true),
  new Field("meeting_date", new Utf8(), true),
  new Field("meeting_title", new Utf8(), true),
  new Field("participants", new Utf8(), true),
  new Field(
    "vector",
    new FixedSizeList(EMBED_DIM, new Field("item", new Float32(), true)),
    false
  ),
]);

export async function openVectorDb(): Promise<lancedb.Connection> {
  mkdirSync(VECTOR_DB_PATH, { recursive: true });
  return await lancedb.connect(VECTOR_DB_PATH);
}

export async function openOrCreateTable(
  db: lancedb.Connection
): Promise<lancedb.Table> {
  const names = await db.tableNames();
  if (names.includes(TABLE_NAME)) {
    try {
      const table = await db.openTable(TABLE_NAME);
      await table.countRows();
      return table;
    } catch (err) {
      console.warn(
        `  LanceDB table "${TABLE_NAME}" is corrupt or unreadable — recreating:`,
        err instanceof Error ? err.message : err
      );
      await db.dropTable(TABLE_NAME);
      const tablePath = join(VECTOR_DB_PATH, `${TABLE_NAME}.lance`);
      if (existsSync(tablePath)) rmSync(tablePath, { recursive: true, force: true });
    }
  }
  return await db.createEmptyTable(TABLE_NAME, chunkSchema);
}
