import type { Meeting, TranscriptItem } from "./types.js";

export interface Chunk {
  id: string;
  recording_id: number;
  kind: "summary" | "transcript";
  chunk_index: number;
  text: string;
  start_timestamp: string | null;
  end_timestamp: string | null;
  speakers: string;
  meeting_date: string;
  meeting_title: string;
  participants: string;
}

const TARGET_WORDS = 250;
const MAX_WORDS = 400;

function countWords(s: string): number {
  return s.trim().split(/\s+/).length;
}

function chunkTranscript(
  transcript: TranscriptItem[]
): Array<{
  text: string;
  start: string | null;
  end: string | null;
  speakers: Set<string>;
}> {
  const chunks: Array<{
    text: string;
    start: string | null;
    end: string | null;
    speakers: Set<string>;
  }> = [];

  let buf: string[] = [];
  let bufWords = 0;
  let start: string | null = null;
  let end: string | null = null;
  const speakers = new Set<string>();

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      text: buf.join("\n"),
      start,
      end,
      speakers: new Set(speakers),
    });
    buf = [];
    bufWords = 0;
    start = null;
    end = null;
    speakers.clear();
  };

  for (const item of transcript) {
    const speaker = item.speaker.name || item.speaker.email || "Unknown";
    const line = `${speaker}: ${item.text}`;
    const w = countWords(line);

    if (bufWords + w > MAX_WORDS && buf.length > 0) {
      flush();
    }

    if (buf.length === 0) start = item.timestamp;
    end = item.timestamp;
    speakers.add(speaker);
    buf.push(line);
    bufWords += w;

    if (bufWords >= TARGET_WORDS) flush();
  }

  flush();
  return chunks;
}

export function chunksForMeeting(meeting: Meeting): Chunk[] {
  const out: Chunk[] = [];
  const date = meeting.created_at.split("T")[0];
  const participants = meeting.calendar_invitees
    .map((p) => p.name || p.email.split("@")[0])
    .join(", ");

  if (meeting.default_summary?.markdown_formatted) {
    out.push({
      id: `${meeting.recording_id}-summary`,
      recording_id: meeting.recording_id,
      kind: "summary",
      chunk_index: 0,
      text: meeting.default_summary.markdown_formatted,
      start_timestamp: null,
      end_timestamp: null,
      speakers: meeting.recorded_by.name,
      meeting_date: date,
      meeting_title: meeting.title,
      participants,
    });
  }

  if (meeting.transcript && meeting.transcript.length > 0) {
    const chunks = chunkTranscript(meeting.transcript);
    chunks.forEach((c, i) => {
      out.push({
        id: `${meeting.recording_id}-t${i}`,
        recording_id: meeting.recording_id,
        kind: "transcript",
        chunk_index: i,
        text: c.text,
        start_timestamp: c.start,
        end_timestamp: c.end,
        speakers: [...c.speakers].join(", "),
        meeting_date: date,
        meeting_title: meeting.title,
        participants,
      });
    });
  }

  return out;
}
