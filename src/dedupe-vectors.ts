import { openVectorDb, openOrCreateTable, TABLE_NAME } from "./lib/vectors.js";

async function main() {
  const db = await openVectorDb();
  const table = await openOrCreateTable(db);
  const total = await table.countRows();
  console.log(`Scanning ${total} rows...`);

  const rows = await table
    .query()
    .select(["id"])
    .limit(total + 10)
    .toArray();

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);

  const dupeIds = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  console.log(
    `Unique: ${counts.size}, duplicated ids: ${dupeIds.length}, total dupes: ${total - counts.size}`
  );

  if (dupeIds.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log("Rebuilding table with unique rows...");

  const allRows = await table
    .query()
    .limit(total + 10)
    .toArray();

  const seen = new Set<string>();
  const unique = [];
  for (const r of allRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    unique.push({
      id: r.id,
      recording_id: r.recording_id,
      kind: r.kind,
      chunk_index: r.chunk_index,
      text: r.text,
      start_timestamp: r.start_timestamp ?? "",
      end_timestamp: r.end_timestamp ?? "",
      speakers: r.speakers ?? "",
      meeting_date: r.meeting_date ?? "",
      meeting_title: r.meeting_title ?? "",
      participants: r.participants ?? "",
      vector: Array.from(r.vector),
    });
  }

  console.log(`Writing ${unique.length} unique rows to new table...`);

  await db.dropTable(TABLE_NAME);
  const fresh = await openOrCreateTable(db);

  const BATCH = 500;
  for (let i = 0; i < unique.length; i += BATCH) {
    await fresh.add(unique.slice(i, i + BATCH));
  }

  const after = await fresh.countRows();
  console.log(`Done. ${after} vectors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
