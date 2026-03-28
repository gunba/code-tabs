---
paths:
  - "src/components/ModalOverlay/**"
---

# Modal Overlay

<!-- Codes: MO=Modal Overlay -->

- [MO-01] Shared modal wrapper: fixed overlay, inset 0, z-index 100, backdrop-filter blur(4px). Blocks all keystrokes except Escape and Ctrl+comma via stopPropagation. Backdrop click calls onClose.
  - Files: src/components/ModalOverlay/ModalOverlay.tsx:1, src/components/ModalOverlay/ModalOverlay.css:1
