/**
 * PTY input line accumulator.
 *
 * Reconstructs submitted lines from the raw byte stream written to a PTY.
 * Handles basic line editing (backspace, Ctrl+U, Ctrl+C), skips terminal
 * escape sequences (CSI, SS3, bracketed paste), and emits completed lines
 * when Enter is pressed.
 */

export class LineAccumulator {
  private buf = "";

  /**
   * Feed raw PTY input data. Returns completed lines (submitted with Enter).
   * Most calls return an empty array.
   */
  feed(data: string): string[] {
    const completed: string[] = [];
    let i = 0;

    while (i < data.length) {
      const ch = data[i];

      // ── Escape sequence handling ──
      if (ch === "\x1b") {
        if (i + 1 < data.length) {
          const next = data[i + 1];
          if (next === "[") {
            // CSI sequence: \x1b[ ... <terminator>
            // Check for bracketed paste start: \x1b[200~
            if (data.startsWith("[200~", i + 1)) {
              const endMarker = data.indexOf("\x1b[201~", i + 6);
              if (endMarker >= 0) {
                // Extract pasted content between markers
                const pasted = data.slice(i + 6, endMarker);
                for (const pch of pasted) {
                  if (pch === "\r" || pch === "\n") {
                    if (this.buf.length > 0) {
                      completed.push(this.buf);
                      this.buf = "";
                    }
                  } else if (pch.charCodeAt(0) >= 32) {
                    this.buf += pch;
                  }
                }
                i = endMarker + 6; // skip past \x1b[201~
                continue;
              }
              // End marker not in this chunk — skip start marker only
              i += 6;
              continue;
            }
            // Regular CSI: skip until terminating byte (0x40–0x7e)
            i += 2;
            while (i < data.length) {
              const code = data.charCodeAt(i);
              i++;
              if (code >= 0x40 && code <= 0x7e) break;
            }
            continue;
          } else if (next === "O") {
            // SS3 sequence (e.g. \x1bOA): skip 3 bytes
            i += 3;
            continue;
          }
        }
        // Bare Escape: clear buffer
        this.buf = "";
        i++;
        continue;
      }

      // ── Enter: emit completed line ──
      if (ch === "\r" || ch === "\n") {
        if (this.buf.length > 0) {
          completed.push(this.buf);
          this.buf = "";
        }
        i++;
        continue;
      }

      // ── Backspace ──
      if (ch === "\x7f" || ch === "\x08") {
        this.buf = this.buf.slice(0, -1);
        i++;
        continue;
      }

      // ── Ctrl+C / Ctrl+U: clear buffer ──
      if (ch === "\x03" || ch === "\x15") {
        this.buf = "";
        i++;
        continue;
      }

      // ── Printable character ──
      if (ch.charCodeAt(0) >= 32) {
        this.buf += ch;
      }
      // else: skip other control chars

      i++;
    }

    // Safety cap
    if (this.buf.length > 500) {
      this.buf = this.buf.slice(-500);
    }

    return completed;
  }

  /** Clear the buffer (e.g. on session respawn). */
  reset(): void {
    this.buf = "";
  }

  /** Current accumulated (incomplete) input. */
  get current(): string {
    return this.buf;
  }
}
