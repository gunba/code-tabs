/** NDJSON terminal recording parser. */

export interface RecordingHeader {
  version: number;
  cols: number;
  rows: number;
  timestamp: number;
}

export interface RecordingEvent {
  t: number;
  phase: string;
  base64?: string;
  cols?: number;
  rows?: number;
}

export interface ParsedRecording {
  header: RecordingHeader;
  events: RecordingEvent[];
  duration: number;
}

/** Parse an NDJSON terminal recording. First line is the header, rest are events. */
export function parseRecording(ndjsonText: string): ParsedRecording {
  const lines = ndjsonText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Empty recording file");

  const header: RecordingHeader = JSON.parse(lines[0]);
  if (header.version !== 1) throw new Error(`Unsupported recording version: ${header.version}`);

  const events: RecordingEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      // Skip malformed lines
    }
  }

  const duration = events.length > 0 ? events[events.length - 1].t : 0;
  return { header, events, duration };
}

/** Decode a base64 recording event payload to a Uint8Array. */
export function decodePayload(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
