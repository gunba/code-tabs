---
paths:
  - "src/components/Icons/Icons.tsx"
---

# src/components/Icons/Icons.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Data Flow

- [DF-08 L3] Icons module: src/components/Icons/Icons.tsx exports 46 inline SVG icon components (stroke-based, 16x16 viewBox, currentColor inheritance, pointerEvents none). Includes scope icons (IconUser, IconBraces, IconTerminal), file icons (IconDocument, IconFolder, IconNotes), agent-type icons mapped from AgentTypeIcon (IconCompass for Explore, IconClipboard for Plan, IconSparkles for general-purpose, IconBookOpen for claude-code-guide, IconTerminal for statusline-setup, IconShieldCheck for verification, IconBot fallback), brand mark IconCode (angle brackets — used in the Linux custom Header next to 'Code Tabs vX.Y.Z'), and IconExternalLink (square with outbound arrow — used by ActivityPanel for the per-row open-in-editor button). No dependencies. All UI icons are monochrome SVGs.
