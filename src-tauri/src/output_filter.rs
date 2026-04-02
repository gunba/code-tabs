/// [PT-17] Output security filter: byte-level state machine.
///
/// Scrollback fix:
///   ESC[2J → ESC[3J + ESC[H + ESC[J (clears scrollback before each full redraw
///   to prevent viewport overflow from duplicating content in scrollback).
///   ESC[3J from the application is always stripped.
///
/// Security:
///   OSC 52 (clipboard write) — stripped (prevents clipboard hijack)
///   DCS sequences — stripped
///   C1 controls (UTF-8 encoded U+0080..U+009F) — stripped (cross-chunk PendingC2)
pub struct OutputFilter {
    state: FilterState,
    output: Vec<u8>,
}

#[derive(Debug)]
enum FilterState {
    Normal,
    /// Saw ESC (0x1B)
    EscapeSeen,
    /// Inside CSI sequence (ESC [)
    InCsi { buf: Vec<u8> },
    /// Inside OSC sequence (ESC ])
    InOsc { buf: Vec<u8> },
    /// Inside DCS sequence (ESC P) — stripped entirely
    InDcs,
    /// DCS: saw ESC, waiting for \ to end
    PendingDcsEsc,
    /// Saw 0xC2 at chunk boundary — might be C1 control
    PendingC2,
}

impl OutputFilter {
    pub fn new() -> Self {
        Self {
            state: FilterState::Normal,
            output: Vec::with_capacity(8192),
        }
    }

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
                    } else if b == 0xC2
                        && i + 1 < data.len()
                        && (0x80..=0x9F).contains(&data[i + 1])
                    {
                        // C1 control in UTF-8 (U+0080..U+009F) — strip
                        i += 2;
                    } else if b == 0xC2 && i + 1 >= data.len() {
                        // 0xC2 at chunk boundary — buffer
                        self.state = FilterState::PendingC2;
                        i += 1;
                    } else {
                        self.output.push(b);
                        i += 1;
                    }
                }

                FilterState::PendingC2 => {
                    let b = data[i];
                    if (0x80..=0x9F).contains(&b) {
                        // C1 control — strip both bytes
                        i += 1;
                    } else {
                        // Valid two-byte char — emit both
                        self.output.push(0xC2);
                        self.output.push(b);
                        i += 1;
                    }
                    self.state = FilterState::Normal;
                }

                FilterState::EscapeSeen => {
                    let b = data[i];
                    i += 1;
                    match b {
                        b'[' => self.state = FilterState::InCsi { buf: Vec::new() },
                        b']' => self.state = FilterState::InOsc { buf: Vec::new() },
                        b'P' => self.state = FilterState::InDcs,
                        _ => {
                            // Unknown ESC sequence — emit as-is
                            self.output.push(0x1B);
                            self.output.push(b);
                            self.state = FilterState::Normal;
                        }
                    }
                }

                FilterState::InCsi { buf } => {
                    let b = data[i];
                    i += 1;
                    if (0x20..=0x3F).contains(&b) {
                        buf.push(b);
                    } else {
                        // Final byte
                        buf.push(b);
                        let owned = std::mem::take(buf);
                        if !self.handle_csi(&owned) {
                            self.output.push(0x1B);
                            self.output.push(b'[');
                            self.output.extend_from_slice(&owned);
                        }
                        self.state = FilterState::Normal;
                    }
                }

                FilterState::InOsc { buf } => {
                    let b = data[i];
                    i += 1;
                    // OSC terminated by BEL (0x07) or ST (ESC \)
                    if b == 0x07 {
                        let owned = std::mem::take(buf);
                        self.handle_osc(&owned);
                        self.state = FilterState::Normal;
                    } else if b == 0x1B {
                        // Check for ST (ESC \)
                        if i < data.len() && data[i] == b'\\' {
                            i += 1;
                            let owned = std::mem::take(buf);
                            self.handle_osc(&owned);
                            self.state = FilterState::Normal;
                        } else {
                            buf.push(b);
                        }
                    } else {
                        buf.push(b);
                    }
                }

                FilterState::InDcs => {
                    // Strip everything until ST (ESC \)
                    let b = data[i];
                    i += 1;
                    if b == 0x1B {
                        self.state = FilterState::PendingDcsEsc;
                    }
                    // else: discard
                }

                FilterState::PendingDcsEsc => {
                    let b = data[i];
                    i += 1;
                    if b == b'\\' {
                        // ST found — DCS done
                        self.state = FilterState::Normal;
                    } else {
                        // Not ST — still inside DCS
                        self.state = FilterState::InDcs;
                    }
                }

            }
        }

        &self.output
    }

    /// Handle a complete CSI sequence. Returns true if consumed.
    fn handle_csi(&mut self, buf: &[u8]) -> bool {
        if buf.is_empty() {
            return false;
        }
        let final_byte = buf[buf.len() - 1];
        let params = &buf[..buf.len() - 1];

        match final_byte {
            // [PT-20] CSI 3 J — erase scrollback. Always stripped.
            b'J' if params == b"3" => true,

            // [PT-20] CSI 2 J — clear screen. Replace with ESC[3J + ESC[H + ESC[J.
            // ESC[3J clears scrollback to prevent duplication from viewport overflow
            // (xterm.js pushes overflow into scrollback during full redraws).
            b'J' if params == b"2" => {
                self.output.extend_from_slice(b"\x1b[3J\x1b[H\x1b[J");
                true
            }

            _ => false,
        }
    }

    /// Handle a complete OSC sequence. Emit if safe, strip if dangerous.
    fn handle_osc(&mut self, buf: &[u8]) {
        let osc_type = self.parse_osc_type(buf);
        match osc_type {
            // OSC 52 — clipboard write. Strip (security).
            52 => {}
            // Everything else — emit
            _ => {
                self.output.push(0x1B);
                self.output.push(b']');
                self.output.extend_from_slice(buf);
                self.output.push(0x07); // BEL terminator
            }
        }
    }

    fn parse_osc_type(&self, buf: &[u8]) -> u32 {
        let mut n: u32 = 0;
        for &b in buf {
            if b.is_ascii_digit() {
                n = n.saturating_mul(10).saturating_add((b - b'0') as u32);
            } else {
                break;
            }
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_normal_text() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"hello world"), b"hello world");
    }

    #[test]
    fn passthrough_normal_csi() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[32mgreen\x1b[0m"), b"\x1b[32mgreen\x1b[0m");
    }

    #[test]
    fn replace_clear_screen() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[2J"), b"\x1b[3J\x1b[H\x1b[J");
    }

    #[test]
    fn strip_erase_scrollback() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1b[3J"), b"");
    }

    #[test]
    fn strip_osc52_clipboard() {
        let mut f = OutputFilter::new();
        // OSC 52 ; c ; base64 BEL
        assert_eq!(f.filter(b"\x1b]52;c;SGVsbG8=\x07"), b"");
    }

    #[test]
    fn passthrough_osc2_title() {
        let mut f = OutputFilter::new();
        let input = b"\x1b]2;My Title\x07";
        let output = f.filter(input);
        assert_eq!(output, b"\x1b]2;My Title\x07");
    }

    #[test]
    fn strip_dcs() {
        let mut f = OutputFilter::new();
        assert_eq!(f.filter(b"\x1bPtest\x1b\\after"), b"after");
    }

    #[test]
    fn strip_c1_controls() {
        let mut f = OutputFilter::new();
        // U+0090 (DCS in C1) encoded as 0xC2 0x90
        let input = [b'a', 0xC2, 0x90, b'b'];
        assert_eq!(f.filter(&input), b"ab");
    }

    #[test]
    fn cross_chunk_esc() {
        let mut f = OutputFilter::new();
        let out1 = f.filter(b"hello\x1b").to_vec();
        assert_eq!(out1, b"hello");
        let out2 = f.filter(b"[2J");
        assert_eq!(out2, b"\x1b[3J\x1b[H\x1b[J");
    }
}
