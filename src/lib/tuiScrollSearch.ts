import { getSessionViewport, waitForRender, isAltScreen, scrollBufferToText } from "./terminalRegistry";
import { writeToPty } from "./ptyRegistry";
import { dlog } from "./debugLog";

// [TA-11] scrollTuiToText: normalizeTargets/viewportIncludesTarget/scrollToTuiEdge helpers; no double-navigate; edge detection by viewport string equality

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

// Strip ANSI escape codes and normalize whitespace for fuzzy viewport matching.
function normalizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeTargets(targetText: string | string[]): string[] {
  return (Array.isArray(targetText) ? targetText : [targetText])
    .map(normalizeText)
    .filter(Boolean);
}

function viewportIncludesTarget(sessionId: string, normalizedTargets: string[]): boolean {
  const currentText = getSessionViewport(sessionId);
  if (!currentText) return false;
  const normalized = normalizeText(currentText);
  return normalizedTargets.some((target) => normalized.includes(target));
}

async function scrollToTuiEdge(
  sessionId: string,
  key: string,
  normalizedTargets: string[],
  signal: AbortSignal,
): Promise<boolean> {
  let prevViewport = getSessionViewport(sessionId) ?? "";
  const MAX_SCROLLS = 500;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    if (signal.aborted) return false;
    writeToPty(sessionId, key);
    await waitForRender(sessionId);
    if (signal.aborted) return false;

    if (viewportIncludesTarget(sessionId, normalizedTargets)) return true;

    const viewport = getSessionViewport(sessionId) ?? "";
    if (viewport === prevViewport) return false;
    prevViewport = viewport;
  }

  return false;
}

/**
 * Scroll a Claude Code TUI to make `targetText` visible in the terminal viewport.
 *
 * Sends Page Up keys to the PTY (Claude Code's TUI handles the scroll), waits for
 * xterm.js onRender (deterministic — no timers), and checks the viewport text after
 * each scroll. Stops when the target is found or the viewport stops changing (edge).
 *
 * Returns true if the text was found in the viewport, false otherwise.
 */
export async function scrollTuiToText(
  sessionId: string,
  targetText: string | string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (!isAltScreen(sessionId)) {
    dlog("search", sessionId, "scrollTuiToText: not in alt-screen, trying buffer scroll", "DEBUG");
    return scrollBufferToText(sessionId, targetText);
  }

  const normalizedTargets = normalizeTargets(targetText);
  if (!normalizedTargets.length) return false;

  // Check if already visible
  if (viewportIncludesTarget(sessionId, normalizedTargets)) {
    dlog("search", sessionId, "scrollTuiToText: target already visible in viewport");
    return true;
  }

  // Establish a known bottom position using TUI-native PageDown. Some TUIs
  // interpret Ctrl+End differently, which made misses strand the viewport at top.
  if (await scrollToTuiEdge(sessionId, PAGE_DOWN, normalizedTargets, signal)) {
    dlog("search", sessionId, "scrollTuiToText: found while scrolling down");
    return true;
  }

  let prevViewport = "";
  const MAX_SCROLLS = 500; // Safety limit

  for (let i = 0; i < MAX_SCROLLS; i++) {
    if (signal.aborted) return false;

    // Send Page Up
    writeToPty(sessionId, PAGE_UP);
    await waitForRender(sessionId);

    if (signal.aborted) return false;

    const viewport = getSessionViewport(sessionId) ?? "";
    const normalized = normalizeText(viewport);

    // Check if target text is now visible
    if (normalizedTargets.some((target) => normalized.includes(target))) {
      dlog("search", sessionId, `scrollTuiToText: found after ${i + 1} scrolls`);
      return true;
    }

    // Edge detection: viewport unchanged means we hit top
    if (viewport === prevViewport) {
      dlog("search", sessionId, `scrollTuiToText: hit edge after ${i + 1} scrolls`);
      if (!signal.aborted) {
        await scrollToTuiEdge(sessionId, PAGE_DOWN, [], signal);
      }
      return false;
    }

    prevViewport = viewport;
  }

  dlog("search", sessionId, "scrollTuiToText: hit scroll limit", "WARN");
  if (!signal.aborted) {
    await scrollToTuiEdge(sessionId, PAGE_DOWN, [], signal);
  }
  return false;
}
