/// Byte-level output filter for the live output path.
///
/// Strips dangerous escape sequences before they reach xterm.js.
/// Handles sequences that span chunk boundaries via internal state machine.
///
/// **Passes through** device queries (DA1, DA2, DSR, CPR, DECRQM, Kitty keyboard)
/// — xterm.js IS the terminal and must respond to these for ConPTY/Claude handshake.
///
/// Tracks BSU/ESU (DEC Mode 2026) synchronized update state so that
/// ESC[2J is only stripped outside sync blocks. Inside sync blocks,
/// ESC[2J is safe — the terminal renders atomically, preventing
/// viewport jumps. ESC[3J (erase scrollback) is always stripped.
pub struct OutputFilter {
    state: FilterState,
    /// Output buffer for the current filter() call
    output: Vec<u8>,
    /// Whether we're inside a BSU/ESU synchronized update block.
    /// ESC[2J is allowed through inside sync blocks (atomic render).
    in_sync_block: bool,
    /// Number of ESC[2J sequences allowed outside sync blocks during
    /// startup. The first 2 clear-screens are needed for the child
    /// process to set up its UI (initial clear + possible config reload).
    startup_clears_remaining: u8,
    /// Metrics
    osc52_stripped: u64,
    osc50_stripped: u64,
    c1_bytes_stripped: u64,
    clear_screen_stripped: u64,
    queries_stripped: u64,
    titles_sanitized: u64,
}

#[derive(Debug)]
enum FilterState {
    Normal,
    /// Saw ESC (0x1B), waiting for next byte
    EscapeSeen,
    /// Inside CSI sequence (ESC [), accumulating parameter bytes
    InCsi { buf: Vec<u8> },
    /// Inside OSC sequence (ESC ]), accumulating until ST
    InOsc { buf: Vec<u8> },
    /// Inside DCS sequence (ESC P), accumulating until ST
    InDcs,
    /// Inside DCS: saw ESC at chunk boundary, waiting for next byte to check for ST (\)
    PendingDcsEsc,
    /// Saw 0xC2 at chunk boundary — waiting for next byte to determine
    /// if this is a C1 control (0xC2 0x80-0x9F) or a valid character
    PendingC2,
}

impl Default for OutputFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputFilter {
    pub fn new() -> Self {
        Self {
            state: FilterState::Normal,
            output: Vec::with_capacity(8192),
            in_sync_block: false,
            startup_clears_remaining: 2,
            osc52_stripped: 0,
            osc50_stripped: 0,
            c1_bytes_stripped: 0,
            clear_screen_stripped: 0,
            queries_stripped: 0,
            titles_sanitized: 0,
        }
    }

    /// Filter a chunk of output. Returns the filtered bytes.
    /// Handles sequences split across chunks via internal state.
    pub fn filter(&mut self, data: &[u8]) -> &[u8] {
        self.output.clear();
        self.output.reserve(data.len());

        let mut i = 0;
        while i < data.len() {
            match &mut self.state {
                FilterState::Normal => {
                    let b = data[i];
                    if b == 0x1B {
                        self.state = FilterState::EscapeSeen;
                        i += 1;
                    } else if b == 0xC2 && i + 1 < data.len() && (0x80..=0x9F).contains(&data[i + 1]) {
                        // C1 control character in UTF-8 encoding (U+0080..U+009F)
                        self.c1_bytes_stripped += 1;
                        i += 2;
                    } else if b == 0xC2 && i + 1 >= data.len() {
                        // 0xC2 at chunk boundary — could be start of C1 or a valid
                        // two-byte character. Buffer it and decide on next chunk.
                        self.state = FilterState::PendingC2;
                        i += 1;
                    } else {
                        self.output.push(b);
                        i += 1;
                    }
                }
                FilterState::EscapeSeen => {
                    let b = data[i];
                    match b {
                        b'[' => {
                            // CSI sequence
                            self.state = FilterState::InCsi { buf: Vec::new() };
                            i += 1;
                        }
                        b']' => {
                            // OSC sequence
                            self.state = FilterState::InOsc { buf: Vec::new() };
                            i += 1;
                        }
                        b'P' => {
                            // DCS sequence — strip entirely
                            self.state = FilterState::InDcs;
                            i += 1;
                        }
                        _ => {
                            // Other ESC sequences (e.g., ESC =, ESC >, ESC M, etc.)
                            // These are generally safe — pass through
                            self.output.push(0x1B);
                            self.output.push(b);
                            self.state = FilterState::Normal;
                            i += 1;
                        }
                    }
                }
                FilterState::InCsi { buf } => {
                    let b = data[i];
                    buf.push(b);
                    i += 1;

                    // CSI parameters are 0x30-0x3F, intermediates are 0x20-0x2F,
                    // final byte is 0x40-0x7E
                    if (0x40..=0x7E).contains(&b) {
                        // Complete CSI sequence — check if it's a query to strip
                        let csi_buf = std::mem::take(buf);
                        self.state = FilterState::Normal;
                        if self.is_blocked_csi(&csi_buf) {
                            // clear_screen_stripped already incremented inside is_blocked_csi
                        } else {
                            // Track BSU/ESU for sync-aware clear-screen filtering
                            if csi_buf == b"?2026h" {
                                self.in_sync_block = true;
                            } else if csi_buf == b"?2026l" {
                                self.in_sync_block = false;
                            }
                            self.output.push(0x1B);
                            self.output.push(b'[');
                            self.output.extend_from_slice(&csi_buf);
                        }
                    }
                    // Still accumulating parameter/intermediate bytes
                }
                FilterState::InOsc { buf } => {
                    let b = data[i];
                    i += 1;

                    // Check if previous byte (in buf) was ESC and this is backslash
                    if b == b'\\' && buf.last() == Some(&0x1B) {
                        // ST terminator (ESC was buffered from previous chunk)
                        buf.pop(); // Remove the ESC from content
                        let osc_buf = std::mem::take(buf);
                        self.state = FilterState::Normal;
                        self.handle_osc(&osc_buf);
                    } else if b == 0x07 {
                        // BEL terminates OSC
                        let osc_buf = std::mem::take(buf);
                        self.state = FilterState::Normal;
                        self.handle_osc(&osc_buf);
                    } else if b == 0x1B {
                        // Could be ESC \ (ST) — peek ahead
                        if i < data.len() && data[i] == b'\\' {
                            // ST terminator
                            i += 1;
                            let osc_buf = std::mem::take(buf);
                            self.state = FilterState::Normal;
                            self.handle_osc(&osc_buf);
                        } else if i >= data.len() {
                            // ESC at end of chunk — could be start of ST
                            buf.push(b);
                        } else {
                            // ESC followed by something else — malformed
                            buf.push(b);
                        }
                    } else {
                        buf.push(b);
                    }
                }
                FilterState::InDcs => {
                    let b = data[i];
                    i += 1;

                    // DCS sequences are stripped entirely — just scan for ST
                    if b == 0x07 {
                        // BEL terminates (some terminals accept this for DCS too)
                        self.queries_stripped += 1;
                        self.state = FilterState::Normal;
                    } else if b == 0x1B {
                        if i < data.len() && data[i] == b'\\' {
                            // ST terminator (ESC \)
                            i += 1;
                            self.queries_stripped += 1;
                            self.state = FilterState::Normal;
                        } else if i >= data.len() {
                            // ESC at chunk boundary — wait for next byte
                            self.state = FilterState::PendingDcsEsc;
                        }
                        // else: ESC followed by non-backslash inside DCS — keep scanning
                    }
                }
                FilterState::PendingDcsEsc => {
                    let b = data[i];
                    if b == b'\\' {
                        // ST terminator completed across chunks
                        i += 1;
                        self.queries_stripped += 1;
                        self.state = FilterState::Normal;
                    } else {
                        // ESC was not start of ST — still inside DCS
                        // Don't consume the byte; it may be another ESC
                        self.state = FilterState::InDcs;
                    }
                }
                FilterState::PendingC2 => {
                    let b = data[i];
                    if (0x80..=0x9F).contains(&b) {
                        // C1 control character (U+0080..U+009F) — strip both bytes
                        self.c1_bytes_stripped += 1;
                        i += 1;
                    } else {
                        // Valid UTF-8 two-byte character starting with 0xC2 — emit both
                        self.output.push(0xC2);
                        self.output.push(b);
                        i += 1;
                    }
                    self.state = FilterState::Normal;
                }
            }
        }

        &self.output
    }

    /// Check if a CSI sequence should be blocked.
    fn is_blocked_csi(&mut self, buf: &[u8]) -> bool {
        if buf.is_empty() {
            return false;
        }

        let final_byte = buf[buf.len() - 1];
        let params = &buf[..buf.len() - 1];

        match final_byte {
            // CSI 3 J — erase scrollback buffer. Always stripped.
            // CSI 2 J — erase entire display. Stripped only OUTSIDE
            // BSU/ESU sync blocks (with a startup grace period).
            b'J' if params == b"3"
                || (params == b"2" && !self.in_sync_block
                    && self.startup_clears_remaining == 0) =>
            {
                self.clear_screen_stripped += 1;
                true
            }
            // ESC[2J outside sync block during startup grace — allow through
            // but decrement the remaining count
            b'J' if params == b"2" && !self.in_sync_block
                && self.startup_clears_remaining > 0 =>
            {
                self.startup_clears_remaining -= 1;
                false
            }
            _ => false,
        }
    }

    /// Handle a complete OSC sequence. Either emit (possibly sanitized) or strip.
    fn handle_osc(&mut self, buf: &[u8]) {
        // Determine OSC type from the numeric prefix
        let osc_type = self.parse_osc_type(buf);

        match osc_type {
            Some(52) => {
                // OSC 52 — clipboard access — STRIP
                self.osc52_stripped += 1;
            }
            Some(50) => {
                // OSC 50 — font query — STRIP
                self.osc50_stripped += 1;
            }
            Some(2) => {
                // OSC 2 — window title — sanitize control characters
                self.titles_sanitized += 1;
                self.emit_sanitized_osc2(buf);
            }
            Some(8) => {
                // OSC 8 — hyperlinks — always pass through
                self.emit_osc_passthrough(buf);
            }
            _ => {
                // Other OSC sequences — pass through
                self.emit_osc_passthrough(buf);
            }
        }
    }

    /// Parse the numeric OSC type (e.g., "2" from "2;title text").
    fn parse_osc_type(&self, buf: &[u8]) -> Option<u32> {
        let semi = buf.iter().position(|&b| b == b';').unwrap_or(buf.len());
        let num_str = std::str::from_utf8(&buf[..semi]).ok()?;
        num_str.parse().ok()
    }

    /// Emit an OSC 2 (window title) with control characters stripped from the title.
    fn emit_sanitized_osc2(&mut self, buf: &[u8]) {
        self.output.push(0x1B);
        self.output.push(b']');

        // Find the semicolon separating "2" from the title
        if let Some(semi_pos) = buf.iter().position(|&b| b == b';') {
            // Emit the "2;" prefix
            self.output.extend_from_slice(&buf[..=semi_pos]);
            // Emit title with control characters stripped
            for &b in &buf[semi_pos + 1..] {
                if b >= 0x20 || b == b'\t' {
                    // Printable or tab — allow
                    self.output.push(b);
                }
                // else: control character — strip
            }
        } else {
            // No semicolon — malformed, emit as-is
            self.output.extend_from_slice(buf);
        }

        self.output.push(0x07); // BEL terminator
    }

    fn emit_osc_passthrough(&mut self, buf: &[u8]) {
        self.output.push(0x1B);
        self.output.push(b']');
        self.output.extend_from_slice(buf);
        self.output.push(0x07);
    }

    #[allow(dead_code)]
    pub fn metrics(&self) -> OutputFilterMetrics {
        OutputFilterMetrics {
            osc52_stripped: self.osc52_stripped,
            osc50_stripped: self.osc50_stripped,
            c1_bytes_stripped: self.c1_bytes_stripped,
            queries_stripped: self.queries_stripped,
            titles_sanitized: self.titles_sanitized,
        }
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct OutputFilterMetrics {
    pub osc52_stripped: u64,
    pub osc50_stripped: u64,
    pub c1_bytes_stripped: u64,
    pub queries_stripped: u64,
    pub titles_sanitized: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plain_text_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"hello world"), b"hello world");
    }

    #[test]
    fn test_sgr_passes_through() {
        let mut f = OutputFilter::new();
        let input = b"\x1b[31mred\x1b[0m";
        assert_eq!(f.filter(input), input.to_vec());
    }

    #[test]
    fn test_cursor_movement_passes_through() {
        let mut f = OutputFilter::new();
        // CUP, CUU, CUD, CUF, CUB
        assert_eq!(f.filter(b"\x1b[10;20H"), b"\x1b[10;20H");
        assert_eq!(f.filter(b"\x1b[5A"), b"\x1b[5A");
        assert_eq!(f.filter(b"\x1b[3B"), b"\x1b[3B");
    }

    #[test]
    fn test_c1_bytes_stripped() {
        let mut f = OutputFilter::new();
        // C1 controls in UTF-8 encoding: 0xC2 followed by 0x80-0x9F
        let result = f.filter(b"hello\xC2\x90world\xC2\x9Bfoo\xC2\x9C");
        assert_eq!(result, b"helloworldfoo");
        assert_eq!(f.metrics().c1_bytes_stripped, 3);
    }

    #[test]
    fn test_osc52_stripped_bel() {
        let mut f = OutputFilter::new();
        let input = b"before\x1b]52;c;SGVsbG8=\x07after";
        assert_eq!(f.filter(input), b"beforeafter");
        assert_eq!(f.metrics().osc52_stripped, 1);
    }

    #[test]
    fn test_osc52_stripped_st() {
        let mut f = OutputFilter::new();
        let input = b"before\x1b]52;c;SGVsbG8=\x1b\\after";
        assert_eq!(f.filter(input), b"beforeafter");
        assert_eq!(f.metrics().osc52_stripped, 1);
    }

    #[test]
    fn test_osc50_stripped() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]50;font query\x07";
        assert_eq!(f.filter(input), b"");
        assert_eq!(f.metrics().osc50_stripped, 1);
    }

    #[test]
    fn test_osc2_title_passes_clean() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]2;My Terminal\x07";
        let result = f.filter(input);
        assert_eq!(result, b"\x1b]2;My Terminal\x07");
    }

    #[test]
    fn test_osc2_title_sanitized() {
        let mut f = OutputFilter::new();
        // Title with embedded control characters
        let input = b"\x1b]2;Evil\x07";
        let result = f.filter(input);
        assert_eq!(result, b"\x1b]2;Evil\x07");

        // Title with embedded newline and other controls
        let input2 = b"\x1b]2;Title\x0d\x0awith\x01controls\x07";
        let result2 = f.filter(input2);
        assert_eq!(result2, b"\x1b]2;Titlewithcontrols\x07");
        assert_eq!(f.metrics().titles_sanitized, 2);
    }

    #[test]
    fn test_da_primary_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[c"), b"\x1b[c");
        assert_eq!(f.filter(b"\x1b[0c"), b"\x1b[0c");
    }

    #[test]
    fn test_da_secondary_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[>c"), b"\x1b[>c");
        assert_eq!(f.filter(b"\x1b[>0c"), b"\x1b[>0c");
    }

    #[test]
    fn test_dsr_cursor_position_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[6n"), b"\x1b[6n");
    }

    #[test]
    fn test_dsr_device_status_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[5n"), b"\x1b[5n");
    }

    #[test]
    fn test_decrqm_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[?1$p"), b"\x1b[?1$p");
    }

    #[test]
    fn test_kitty_keyboard_query_passes_through() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[?u"), b"\x1b[?u");
    }

    #[test]
    fn test_dcs_stripped() {
        let mut f = OutputFilter::new();
        let input = b"\x1bP$q some data\x1b\\";
        assert_eq!(f.filter(input), b"");
        assert_eq!(f.metrics().queries_stripped, 1);
    }

    #[test]
    fn test_osc8_https_passes_through() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_osc8_http_passes_through() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]8;;http://example.com\x07link\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_osc8_file_passes_through() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]8;;file:///tmp/foo.rs\x07foo.rs\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_osc8_non_standard_scheme_passes_through() {
        let mut f = OutputFilter::new();
        // SSH, javascript, x-man-page — all pass through (no scheme filtering)
        let input = b"\x1b]8;;ssh://example.com\x07click\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());

        let input2 = b"\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07";
        let result2 = f.filter(input2);
        assert_eq!(result2, input2.to_vec());
    }

    #[test]
    fn test_osc8_closing_tag_always_passes() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_osc8_with_params_passes() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]8;id=link1;https://example.com\x07text\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_osc8_case_insensitive_scheme() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]8;;HTTPS://example.com\x07link\x1b]8;;\x07";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_mixed_safe_and_unsafe() {
        let mut f = OutputFilter::new();
        let input = b"\x1b[31mred\x1b]52;c;data\x07\x1b[0m normal\x1b[c";
        let result = f.filter(input);
        // SGR red passes, OSC 52 stripped, SGR reset passes, text passes, DA passes
        assert_eq!(result, b"\x1b[31mred\x1b[0m normal\x1b[c");
    }

    #[test]
    fn test_empty_input() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b""), b"");
    }

    #[test]
    fn test_chunk_boundary_osc52() {
        let mut f = OutputFilter::new();
        // OSC 52 split across two chunks
        let result1 = f.filter(b"before\x1b]52;c;da").to_vec();
        let result2 = f.filter(b"ta\x07after");
        assert_eq!(result1, b"before");
        assert_eq!(result2, b"after");
    }

    #[test]
    fn test_chunk_boundary_csi() {
        let mut f = OutputFilter::new();
        // CSI sequence split: ESC [ in chunk 1, 31 m in chunk 2
        let result1 = f.filter(b"text\x1b[").to_vec();
        let result2 = f.filter(b"31m more");
        assert_eq!(result1, b"text");
        assert_eq!(result2, b"\x1b[31m more");
    }

    #[test]
    fn test_chunk_boundary_esc_at_end() {
        let mut f = OutputFilter::new();
        // ESC at end of chunk
        let result1 = f.filter(b"text\x1b").to_vec();
        let result2 = f.filter(b"[32mgreen");
        assert_eq!(result1, b"text");
        assert_eq!(result2, b"\x1b[32mgreen");
    }

    #[test]
    fn test_chunk_boundary_st_split() {
        let mut f = OutputFilter::new();
        // OSC 52 with ST (ESC \) split: ESC at chunk end, \ at next chunk start
        let result1 = f.filter(b"\x1b]52;c;data\x1b").to_vec();
        let result2 = f.filter(b"\\next");
        assert_eq!(result1, b"");
        assert_eq!(result2, b"next");
    }

    #[test]
    fn test_other_esc_sequences_pass_through() {
        let mut f = OutputFilter::new();
        // ESC =, ESC >, ESC M (reverse index) etc.
        assert_eq!(f.filter(b"\x1b="), b"\x1b=");
        assert_eq!(f.filter(b"\x1b>"), b"\x1b>");
        assert_eq!(f.filter(b"\x1bM"), b"\x1bM");
    }

    #[test]
    fn test_all_c1_range_stripped() {
        let mut f = OutputFilter::new();
        // All C1 controls in UTF-8 encoding: 0xC2 0x80 through 0xC2 0x9F
        let mut input = Vec::new();
        for b in 0x80u8..=0x9F {
            input.push(0xC2);
            input.push(b);
        }
        let result = f.filter(&input);
        assert!(result.is_empty());
        assert_eq!(f.metrics().c1_bytes_stripped, 32);
    }

    #[test]
    fn test_utf8_continuation_bytes_preserved() {
        let mut f = OutputFilter::new();
        // U+276F (❯) = E2 9D AF — 0x9D is a continuation byte, not a C1 control
        let input = "before❯after".as_bytes();
        let result = f.filter(input);
        assert_eq!(result, input);
    }

    #[test]
    fn test_utf8_box_drawing_preserved() {
        let mut f = OutputFilter::new();
        // Box-drawing characters with continuation bytes in 0x80-0x9F range
        let input = "┌──┐│hi│└──┘".as_bytes();
        let result = f.filter(input);
        assert_eq!(result, input);
    }

    #[test]
    fn test_c1_at_chunk_boundary() {
        let mut f = OutputFilter::new();
        // C1 control split across chunks: 0xC2 at end of chunk 1, 0x90 at start of chunk 2
        let result1 = f.filter(b"text\xC2").to_vec();
        let result2 = f.filter(b"\x90more");
        assert_eq!(result1, b"text");
        assert_eq!(result2, b"more");
        assert_eq!(f.metrics().c1_bytes_stripped, 1);
    }

    #[test]
    fn test_c2_non_c1_at_chunk_boundary() {
        let mut f = OutputFilter::new();
        // Valid UTF-8 char starting with 0xC2 split across chunks
        // U+00A9 (©) = C2 A9 — NOT a C1 control
        let result1 = f.filter(b"text\xC2").to_vec();
        let result2 = f.filter(b"\xA9more");
        assert_eq!(result1, b"text");
        assert_eq!(result2, b"\xC2\xA9more");
    }

    // ── Sync-aware ESC[2J filtering ──────────────────────────────────

    #[test]
    fn test_clear_screen_stripped_outside_sync_block() {
        let mut f = OutputFilter::new();
        // First 2 ESC[2J outside sync blocks are allowed (startup grace)
        let r1 = f.filter(b"\x1b[2J").to_vec();
        assert_eq!(r1, b"\x1b[2J"); // 1st — allowed
        let r2 = f.filter(b"\x1b[2J").to_vec();
        assert_eq!(r2, b"\x1b[2J"); // 2nd — allowed
        // 3rd — stripped
        let r3 = f.filter(b"before\x1b[2Jafter");
        assert_eq!(r3, b"beforeafter");
    }

    #[test]
    fn test_clear_screen_passes_inside_sync_block() {
        let mut f = OutputFilter::new();
        // BSU + ESC[2J + ESU — clear screen inside sync block passes through
        let input = b"\x1b[?2026h\x1b[2J\x1b[Hcontent\x1b[?2026l";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn test_erase_scrollback_always_stripped() {
        let mut f = OutputFilter::new();
        // ESC[3J stripped outside sync block
        assert_eq!(f.filter(b"\x1b[3J"), b"");

        // ESC[3J stripped inside sync block too
        let result = f.filter(b"\x1b[?2026h\x1b[3Jcontent\x1b[?2026l");
        assert_eq!(result, b"\x1b[?2026hcontent\x1b[?2026l");
    }

    #[test]
    fn test_sync_state_across_chunks() {
        let mut f = OutputFilter::new();
        // BSU in chunk 1
        let r1 = f.filter(b"\x1b[?2026h").to_vec();
        assert_eq!(r1, b"\x1b[?2026h");

        // ESC[2J in chunk 2 — should pass through (inside sync block)
        let r2 = f.filter(b"\x1b[2J\x1b[Hcontent").to_vec();
        assert_eq!(r2, b"\x1b[2J\x1b[Hcontent");

        // ESU in chunk 3
        let r3 = f.filter(b"\x1b[?2026l").to_vec();
        assert_eq!(r3, b"\x1b[?2026l");
    }

    #[test]
    fn test_sync_state_resets_after_esu() {
        let mut f = OutputFilter::new();
        // Exhaust startup grace period
        f.filter(b"\x1b[2J");
        f.filter(b"\x1b[2J");

        // Complete sync block — ESC[2J passes through (inside sync)
        f.filter(b"\x1b[?2026h\x1b[2Jcontent\x1b[?2026l");

        // ESC[2J after sync block ends — should be stripped (grace exhausted)
        let result = f.filter(b"\x1b[2Jmore");
        assert_eq!(result, b"more");
    }

    #[test]
    fn test_bsu_esu_sequences_pass_through() {
        let mut f = OutputFilter::new();
        let bsu = b"\x1b[?2026h";
        let esu = b"\x1b[?2026l";
        assert_eq!(f.filter(bsu), bsu.to_vec());
        assert_eq!(f.filter(esu), esu.to_vec());
    }

    // ── DCS chunk boundary tests ────────────────────────────────────

    #[test]
    fn test_dcs_st_split_across_chunks() {
        let mut f = OutputFilter::new();
        // DCS with ST (ESC \) split: ESC at end of chunk 1, \ at start of chunk 2
        let result1 = f.filter(b"\x1bPsome dcs data\x1b").to_vec();
        let result2 = f.filter(b"\\after");
        assert_eq!(result1, b"");
        assert_eq!(result2, b"after");
        assert_eq!(f.metrics().queries_stripped, 1);
    }

    #[test]
    fn test_dcs_terminated_by_bel() {
        let mut f = OutputFilter::new();
        let input = b"before\x1bP$q dcs content\x07after";
        let result = f.filter(input);
        assert_eq!(result, b"beforeafter");
        assert_eq!(f.metrics().queries_stripped, 1);
    }

    // ── OSC edge cases ──────────────────────────────────────────────

    #[test]
    fn test_osc_malformed_no_semicolon() {
        let mut f = OutputFilter::new();
        // OSC with no semicolon — parse_osc_type returns None, passes through
        let input = b"\x1b]nosemicolon\x07";
        let result = f.filter(input);
        // Should pass through as-is (wrapped in OSC + BEL)
        assert_eq!(result, b"\x1b]nosemicolon\x07");
    }

    #[test]
    fn test_osc2_malformed_no_semicolon() {
        let mut f = OutputFilter::new();
        // "2" with no semicolon — parse_osc_type returns Some(2) but no semicolon
        // in handle_osc, it falls through to the "no semicolon" branch
        let input = b"\x1b]2\x07";
        let result = f.filter(input);
        assert_eq!(result, b"\x1b]2\x07");
        assert_eq!(f.metrics().titles_sanitized, 1);
    }

    // ── Startup grace period ────────────────────────────────────────

    #[test]
    fn test_startup_grace_exactly_two_clears() {
        let mut f = OutputFilter::new();
        // First clear — allowed (grace 2 -> 1)
        let r1 = f.filter(b"\x1b[2J").to_vec();
        assert_eq!(r1, b"\x1b[2J");
        // Second clear — allowed (grace 1 -> 0)
        let r2 = f.filter(b"\x1b[2J").to_vec();
        assert_eq!(r2, b"\x1b[2J");
        // Third clear — stripped (grace exhausted)
        let r3 = f.filter(b"\x1b[2J").to_vec();
        assert!(r3.is_empty(), "third ESC[2J should be stripped after grace exhausted");
        // Fourth clear — also stripped
        let r4 = f.filter(b"\x1b[2J").to_vec();
        assert!(r4.is_empty(), "fourth ESC[2J should also be stripped");
    }

    #[test]
    fn test_startup_grace_not_consumed_by_sync_block_clears() {
        let mut f = OutputFilter::new();
        // ESC[2J inside sync block should NOT consume startup grace
        f.filter(b"\x1b[?2026h\x1b[2J\x1b[?2026l");
        // Grace should still be 2
        let r1 = f.filter(b"\x1b[2J").to_vec();
        assert_eq!(r1, b"\x1b[2J"); // First grace — allowed
        let r2 = f.filter(b"\x1b[2J").to_vec();
        assert_eq!(r2, b"\x1b[2J"); // Second grace — allowed
        let r3 = f.filter(b"\x1b[2J").to_vec();
        assert!(r3.is_empty()); // Grace exhausted — stripped
    }

    // ── ESC at end of DCS without matching ST ───────────────────────

    #[test]
    fn test_dcs_esc_at_chunk_boundary_not_st() {
        let mut f = OutputFilter::new();
        // DCS with ESC at chunk end, but next byte is NOT backslash
        let result1 = f.filter(b"\x1bPdcs data\x1b").to_vec();
        // ESC at end of DCS chunk — state stays InDcs
        assert_eq!(result1, b"");
        // Next chunk starts with '[' not '\' — ESC wasn't ST, still inside DCS
        let result2 = f.filter(b"[31mmore\x1b\\after");
        // The DCS finally terminates at \x1b\\
        assert_eq!(result2, b"after");
    }

    // ── Multiple CSI queries in one chunk ───────────────────────────

    #[test]
    fn test_device_queries_pass_through_same_chunk() {
        let mut f = OutputFilter::new();
        // DA1 + DSR + kitty keyboard query in one chunk — all pass through
        let input = b"\x1b[c\x1b[6n\x1b[?u";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }

    // ── ESC[1J (erase above) should pass through ───────────────────

    #[test]
    fn test_erase_above_passes_through() {
        let mut f = OutputFilter::new();
        // ESC[1J is erase above — NOT blocked
        let input = b"\x1b[1J";
        let result = f.filter(input);
        assert_eq!(result, input.to_vec());
    }
}
