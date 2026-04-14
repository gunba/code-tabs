---
paths:
  - "src/components/Header/Header.tsx"
---

# src/components/Header/Header.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Version & Auto-Update

- [VA-02 L6] Header (Linux custom titlebar): compact bar showing app version and running CLI version. Renders window controls (minimize/maximize/close) via Tauri window API. Shown only on Linux (setDecorations(false) removes OS chrome; Header is the custom replacement). App and CLI update buttons are in StatusBar, not Header.
