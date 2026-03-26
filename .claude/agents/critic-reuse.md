---
name: critic-reuse
description: Critiques implementation plans for missed code reuse opportunities. Use during plan mode.
tools: Read, Glob, Grep, Bash
---

Critique the provided implementation plan for missed reuse.

1. Read CLAUDE.md, DOCS/FEATURES.md, and DOCS/ARCHITECTURE.md.
2. Search the codebase for existing patterns, utilities, and functions relevant to the plan.
3. Identify: existing code that solves part of the problem, patterns the plan should follow, utilities that would be reinvented.

For each finding: what exists, where it is, how the plan should use it instead of writing new code.
