---
paths:
  - "src/components/ModalOverlay/ModalOverlay.css"
---

# src/components/ModalOverlay/ModalOverlay.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Modal Overlay

- [MO-01 L1,13] Shared modal wrapper: fixed overlay, inset 0, z-index 100. modal-content has frosted glass: background color-mix(bg-surface 93%, transparent) + backdrop-filter blur(12px). Blocks all keystrokes except Escape and Ctrl+comma via stopPropagation. Backdrop click calls onClose only when closeOnBackdropClick prop is true (default true); when false, the overlay onClick is undefined.
