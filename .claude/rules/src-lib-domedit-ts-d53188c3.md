---
paths:
  - "src/lib/domEdit.ts"
---

# src/lib/domEdit.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## DOM Edit Helpers

- [DE-01 L11] replaceTextareaValue(el, next) and insertTextAtCursor(el, text) use document.execCommand('insertText') so programmatic edits push a single undoable step onto the browser's native undo stack. When execCommand returns false (security policy, blocked element, unfocused), falls back to direct value splice + synthetic InputEvent (bubbles:true, inputType insertReplacementText/insertText) to keep React-mirrored state in sync. The undo stack is lost in the fallback path but the data is not.
