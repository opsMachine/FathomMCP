import type { TranscriptSpeaker } from "./types.js";

export function formatSpeakerLabel(speaker: TranscriptSpeaker): string {
  return (
    speaker.display_name ||
    speaker.name ||
    speaker.matched_calendar_invitee_email ||
    speaker.email ||
    "Unknown"
  );
}
