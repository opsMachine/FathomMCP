import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { INDEX_DB_PATH } from "./paths.js";

export function openDb(): Database.Database {
  mkdirSync(dirname(INDEX_DB_PATH), { recursive: true });
  const db = new Database(INDEX_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      recording_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      meeting_title TEXT,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      recording_start TEXT,
      recording_end TEXT,
      duration_seconds INTEGER,
      url TEXT NOT NULL,
      share_url TEXT,
      recorded_by_email TEXT NOT NULL,
      recorded_by_name TEXT NOT NULL,
      meeting_type TEXT,
      language TEXT,
      summary_markdown TEXT,
      has_transcript INTEGER NOT NULL DEFAULT 0,
      transcript_entry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
    CREATE INDEX IF NOT EXISTS idx_meetings_type ON meetings(meeting_type);
    CREATE INDEX IF NOT EXISTS idx_meetings_recorded_by ON meetings(recorded_by_email);

    CREATE TABLE IF NOT EXISTS participants (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      meeting_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_participants_domain ON participants(domain);
    CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS meeting_participants (
      recording_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      is_organizer INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (recording_id, email),
      FOREIGN KEY (recording_id) REFERENCES meetings(recording_id) ON DELETE CASCADE,
      FOREIGN KEY (email) REFERENCES participants(email) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mp_email ON meeting_participants(email);
    CREATE INDEX IF NOT EXISTS idx_mp_recording ON meeting_participants(recording_id);

    CREATE TABLE IF NOT EXISTS companies (
      domain TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      meeting_count INTEGER NOT NULL DEFAULT 0,
      contact_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS meeting_companies (
      recording_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      PRIMARY KEY (recording_id, domain),
      FOREIGN KEY (recording_id) REFERENCES meetings(recording_id) ON DELETE CASCADE,
      FOREIGN KEY (domain) REFERENCES companies(domain) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mc_domain ON meeting_companies(domain);

    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
      recording_id UNINDEXED,
      title,
      summary
    );

    CREATE TABLE IF NOT EXISTS person_labels (
      email TEXT NOT NULL,
      tag TEXT NOT NULL,
      notes TEXT,
      PRIMARY KEY (email, tag),
      FOREIGN KEY (email) REFERENCES participants(email) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_person_labels_tag ON person_labels(tag);
    CREATE INDEX IF NOT EXISTS idx_person_labels_email ON person_labels(email);

    CREATE TABLE IF NOT EXISTS meeting_labels (
      recording_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      notes TEXT,
      PRIMARY KEY (recording_id, tag),
      FOREIGN KEY (recording_id) REFERENCES meetings(recording_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_meeting_labels_tag ON meeting_labels(tag);
    CREATE INDEX IF NOT EXISTS idx_meeting_labels_recording ON meeting_labels(recording_id);

    CREATE TABLE IF NOT EXISTS company_labels (
      domain TEXT NOT NULL,
      tag TEXT NOT NULL,
      notes TEXT,
      PRIMARY KEY (domain, tag),
      FOREIGN KEY (domain) REFERENCES companies(domain) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_company_labels_tag ON company_labels(tag);
    CREATE INDEX IF NOT EXISTS idx_company_labels_domain ON company_labels(domain);
  `);
}

export function clearAll(db: Database.Database): void {
  db.exec(`
    DELETE FROM meeting_participants;
    DELETE FROM meeting_companies;
    DELETE FROM person_labels;
    DELETE FROM meeting_labels;
    DELETE FROM company_labels;
    DELETE FROM meetings;
    DELETE FROM participants;
    DELETE FROM companies;
    DELETE FROM meetings_fts;
  `);
}
