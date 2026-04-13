/**
 * File tree builder for the Activity Panel.
 *
 * Converts a flat set of file paths into a hierarchical tree structure
 * suitable for rendering as a file explorer. Each top-level touched
 * folder appears as its own root node — there is no synthetic wrapper
 * spanning a common ancestor. The workspace directory node is marked
 * with isWorkspaceRoot for styling. Single-child directory chains are
 * compressed (VSCode compact folders), except that compression never
 * collapses through the workspace root.
 */

import type { FileActivity } from "../types/activity";
import { canonicalizePath, parseWorktreePath } from "./paths";

export interface FileTreeNode {
  /** Display name — the last segment (or compressed chain) of this node's path. */
  name: string;
  /** Original full path (as stored in FileActivity.path) for lookups. */
  fullPath: string;
  /** True for leaf file nodes, false for directories. */
  isFile: boolean;
  /** Sorted children: directories first, then case-insensitive alphabetical. */
  children: FileTreeNode[];
  /** Non-null for file (leaf) nodes — the latest activity record. */
  activity: FileActivity | null;
  /** True when this folder node is the workspace root directory. */
  isWorkspaceRoot: boolean;
}

/** Intermediate trie node used during tree construction. */
interface TrieNode {
  children: Map<string, TrieNode>;
  /** Set when this node corresponds to an actual visited file. */
  activity: FileActivity | null;
  /** Original full path for file leaves. */
  originalPath: string | null;
  /** Whether this trie node is the workspace root. */
  isWorkspaceRoot: boolean;
}

function newTrieNode(): TrieNode {
  return { children: new Map(), activity: null, originalPath: null, isWorkspaceRoot: false };
}

/**
 * Split a forward-slash-normalized path into segments.
 * Handles Windows drive letters (e.g. "C:/Users/...") and Unix absolute paths.
 */
function splitSegments(normalizedPath: string): string[] {
  const trimmed = normalizedPath.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean);
}

/**
 * Build a unified file tree from a map of file paths and a workspace directory.
 *
 * Each top-level touched folder appears as its own root node. The node
 * matching the workspace directory (if present in the tree) is marked
 * with isWorkspaceRoot.
 */
// [AP-02] Flat top-level roots with workspace marking, worktree project name, and single-child compression
export function buildFileTree(
  files: Map<string, FileActivity>,
  workspaceDir: string,
): FileTreeNode[] {
  if (files.size === 0) return [];

  const canonWs = canonicalizePath(workspaceDir);
  const wsSegments = canonWs ? splitSegments(canonWs) : [];

  // Build a single trie from ALL file paths
  const root = newTrieNode();

  for (const [path, activity] of files) {
    const normalized = canonicalizePath(path);
    const segments = splitSegments(normalized);
    if (segments.length === 0) continue;

    let current = root;
    for (const segment of segments) {
      if (!current.children.has(segment)) {
        current.children.set(segment, newTrieNode());
      }
      current = current.children.get(segment)!;
    }
    current.activity = activity;
    current.originalPath = path;
  }

  // Mark the workspace root node in the trie
  if (wsSegments.length > 0) {
    let current: TrieNode | undefined = root;
    for (const seg of wsSegments) {
      current = current?.children.get(seg);
      if (!current) break;
    }
    if (current) {
      current.isWorkspaceRoot = true;
    }
  }

  const nodes = trieToNodes(root, "");
  const compressed = compressTree(nodes);

  // Rename the workspace root node to the project name for worktrees
  const wt = canonWs ? parseWorktreePath(canonWs) : null;
  if (wt) {
    renameWorkspaceRoot(compressed, wt.projectName);
  }

  return compressed;
}

/** Rename the first workspace root node found in the tree to a friendly display name. */
function renameWorkspaceRoot(nodes: FileTreeNode[], projectName: string): void {
  for (const node of nodes) {
    if (node.isWorkspaceRoot) {
      node.name = projectName;
      return;
    }
    if (!node.isFile) {
      renameWorkspaceRoot(node.children, projectName);
    }
  }
}

/** Recursively convert trie children into sorted FileTreeNode arrays. */
function trieToNodes(trie: TrieNode, parentPath: string): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];

  for (const [name, child] of trie.children) {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    const isFile = child.activity !== null && !child.activity.isFolder;

    const node: FileTreeNode = {
      name,
      // For files, use the original path for downstream lookups (shell_open, mascot matching).
      // For folders, use the reconstructed forward-slash path.
      fullPath: isFile && child.originalPath ? child.originalPath : fullPath,
      isFile,
      children: isFile ? [] : trieToNodes(child, fullPath),
      activity: child.activity,
      isWorkspaceRoot: child.isWorkspaceRoot,
    };

    nodes.push(node);
  }

  // Sort: directories first, then case-insensitive alphabetical
  nodes.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return nodes;
}

/**
 * Compress single-child directory chains (VSCode "compact folders").
 * E.g. src -> components -> Panel becomes "src/components/Panel".
 * Never compresses through a workspace root node.
 */
function compressTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.isFile) return node;

    // Recurse first so children are already compressed
    const compressed = compressTree(node.children);

    // If this directory has exactly one child and it's also a directory,
    // merge them — UNLESS either node is the workspace root (must remain visible)
    if (
      compressed.length === 1 &&
      !compressed[0].isFile &&
      !compressed[0].isWorkspaceRoot &&
      !node.isWorkspaceRoot &&
      !node.activity &&
      !compressed[0].activity
    ) {
      const child = compressed[0];
      return {
        name: `${node.name}/${child.name}`,
        fullPath: child.fullPath,
        isFile: false,
        children: child.children,
        activity: null,
        isWorkspaceRoot: node.isWorkspaceRoot,
      };
    }

    return { ...node, children: compressed };
  });
}

/**
 * Flatten a tree into a depth-annotated list for rendering.
 * Only includes nodes whose ancestors are all expanded.
 */
export interface FlatTreeRow {
  node: FileTreeNode;
  depth: number;
  /** Unique key for React rendering. */
  key: string;
}

export function flattenTree(
  roots: FileTreeNode[],
  expandedPaths: Set<string>,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];

  function walk(nodes: FileTreeNode[], depth: number) {
    for (const node of nodes) {
      rows.push({ node, depth, key: node.fullPath });
      if (!node.isFile && expandedPaths.has(node.fullPath)) {
        walk(node.children, depth + 1);
      }
    }
  }

  walk(roots, 0);
  return rows;
}

/**
 * Collect all folder paths in a tree (for default-expand-all behavior).
 */
export function allFolderPaths(roots: FileTreeNode[]): Set<string> {
  const paths = new Set<string>();

  function walk(nodes: FileTreeNode[]) {
    for (const node of nodes) {
      if (!node.isFile) {
        paths.add(node.fullPath);
        walk(node.children);
      }
    }
  }

  walk(roots);
  return paths;
}
