import pThrottle from "p-throttle";
import type { MeetingListResponse } from "./types.js";

const BASE_URL = "https://api.fathom.ai/external/v1";

const throttle = pThrottle({ limit: 55, interval: 60_000 });

export function createFathomClient(apiKey: string) {
  const throttledFetch = throttle(async (url: string) => {
    const res = await fetch(url, {
      headers: { "X-Api-Key": apiKey },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10_000;
      console.log(`  Rate limited. Waiting ${waitMs / 1000}s...`);
      await sleep(waitMs);
      return fetch(url, { headers: { "X-Api-Key": apiKey } });
    }

    if (!res.ok) {
      throw new Error(`Fathom API ${res.status}: ${await res.text()}`);
    }

    return res;
  });

  async function listMeetings(params: {
    cursor?: string;
    createdAfter?: string;
    includeTranscript?: boolean;
    includeSummary?: boolean;
  }): Promise<MeetingListResponse> {
    const url = new URL(`${BASE_URL}/meetings`);

    if (params.cursor) url.searchParams.set("cursor", params.cursor);
    if (params.createdAfter)
      url.searchParams.set("created_after", params.createdAfter);
    if (params.includeTranscript)
      url.searchParams.set("include_transcript", "true");
    if (params.includeSummary)
      url.searchParams.set("include_summary", "true");

    const res = await throttledFetch(url.toString());
    return (await res.json()) as MeetingListResponse;
  }

  return { listMeetings };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
