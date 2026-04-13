---
paths:
  - "src/lib/fileTree.ts"
---

# src/lib/fileTree.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Panel

- [AP-02 L62] buildFileTree() in fileTree.ts builds a unified hierarchical FileTreeNode tree from a Map<path, FileActivity> and a workspaceDir. All files (workspace-internal and external) are placed in a single tree rooted at the deepest common ancestor. The workspace directory node is marked with isWorkspaceRoot=true for accent styling. For worktree workspaces, the workspace root uses the project name via parseWorktreePath(). Single-child directory chains are compressed (VSCode compact-folders style), but compression never collapses through the workspace root. Nodes sorted: directories first, then case-insensitive alphabetical. flattenTree() and allFolderPaths() are companion utilities for rendering and auto-expand.
