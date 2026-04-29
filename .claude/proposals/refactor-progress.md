# Refactor Progress

Updated: 2026-04-29

## Completed before this checklist

- [x] F4-12 remove terminal render timeout fallback — `f4eba45`
- [x] F9-3 shared text-file editor lifecycle — `aa16707`
- [x] F9-4 config file refresh/watching — `7685bc2`
- [x] F9-5 config status flash cleanup — `187611a`

## Active list

- [x] F8-3 SessionLauncher state reducer or equivalent state model
- [x] F5-10 split useTapEventProcessor by concern
- [x] F7-1 decompose TerminalPanel effects
- [ ] R9-F13 broader weather country mapping
- [ ] F2-6 split settings.ts into coherent slices
- [ ] F4-01 full useTerminal decomposition
- [ ] F10 useAbortableEffect
- [ ] R10-F8 configurable diff context radius
- [ ] R5-F12 move weather forwarding out of proxy hot path
- [ ] F4-05 unify terminal write/writeBytes paths
- [ ] F4-09 theme variable ownership refactor
- [ ] F6-7 split claude.ts
- [ ] F6-8 delete or inline usePty.ts
- [ ] F9 reducer-per-pane/lifted form state decision

## Decisions

- F9 reducer-per-pane/lifted form state remains pending review. The current evidence still points to the shared editor and unsaved guard abstractions as the correct layer, so this item may close as rejected rather than implemented.
