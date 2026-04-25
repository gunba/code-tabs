// Helpers that mutate textareas through the browser's edit history rather
// than via React's value prop. Programmatic value writes (setText, etc.) clear
// the native undo stack on most webview engines; execCommand('insertText') is
// the only API that pushes the edit onto that stack as a single undoable step.
//
// execCommand is deprecated and may return false (security policy, blocked
// element, no focus). We fall back to splicing the value directly and firing
// a synthetic input event so React-mirrored state stays in sync — the undo
// stack is lost in that path, but the data is not.

// [DE-01] replaceTextareaValue / insertTextAtCursor: execCommand('insertText') for native undo; fallback to value splice + synthetic InputEvent
export function replaceTextareaValue(el: HTMLTextAreaElement | null, next: string): void {
  if (!el) return;
  if (el.value === next) return;
  el.focus();
  el.select();
  if (document.execCommand("insertText", false, next)) return;
  el.value = next;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: next }));
}

export function insertTextAtCursor(el: HTMLTextAreaElement | null, text: string): void {
  if (!el) return;
  el.focus();
  if (document.execCommand("insertText", false, text)) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.selectionStart = caret;
  el.selectionEnd = caret;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}
