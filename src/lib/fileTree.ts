/**
 * File tree builder for the Activity Panel.
 *
 * Converts a flat set of file paths into a hierarchical tree structure
 * suitable for rendering as a file explorer. Only paths that agents have
 * visited appear in the tree — ancestor folders are included to show
 * the spatial context.
 */

import type { FileActivity } from "../types/activity";

export interface FileTreeNode {
  /** Display name — the last segment of this node's path. */
  name: string;
  /** Original full path (as stored in FileActivity.path) for lookups. */
  fullPath: string;
  /** True for leaf file nodes, false for directories. */
  isFile: boolean;
  /** Sorted children: directories first, then case-insensitive alphabetical. */
  children: FileTreeNode[];
  /** Non-null for file (leaf) nodes — the latest activity record. */
  activity: FileActivity | null;
}

/** Intermediate trie node used during tree construction. */
interface TrieNode {
  children: Map<string, TrieNode>;
  /** Set when this node corresponds to an actual visited file. */
  activity: FileActivity | null;
  /** Original full path for file leaves. */
  originalPath: string | null;
}

function newTrieNode(): TrieNode {
  return { children: new Map(), activity: null, originalPath: null };
}

/** Convert backslashes to forward slashes for consistent segment splitting. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Split a forward-slash-normalized path into segments.
 * Handles Windows drive letters (e.g. "C:/Users/...") and Unix absolute paths.
 */
function splitSegments(normalizedPath: string): string[] {
  // Trim leading/trailing slashes but preserve drive letter
  const trimmed = normalizedPath.replace(/\/+$/, "");
  const segments = trimmed.split("/").filter(Boolean);

  // Reconstruct drive letter if present: ["C:", "Users"] stays as-is
  // Unix root paths: "/home/user" → ["home", "user"] — we lose the leading /
  // but fullPath is preserved from the original for lookups.
  return segments;
}

/**
 * Build a file tree from a map of file paths to their latest activity.
 *
 * Returns an array of root-level nodes. Multiple disjoint path trees
 * (e.g. workspace files + external files) produce multiple roots.
 */
export function buildFileTree(files: Map<string, FileActivity>): FileTreeNode[] {
  if (files.size === 0) return [];

  const root = newTrieNode();

  // Insert each file path into the trie
  for (const [path, activity] of files) {
    const normalized = toForwardSlash(path);
    const segments = splitSegments(normalized);
    if (segments.length === 0) continue;

    let current = root;
    for (const segment of segments) {
      if (!current.children.has(segment)) {
        current.children.set(segment, newTrieNode());
      }
      current = current.children.get(segment)!;
    }
    // Mark the leaf as a visited file
    current.activity = activity;
    current.originalPath = path;
  }

  // Convert trie to FileTreeNode array
  return trieToNodes(root, "");
}

/** Recursively convert trie children into sorted FileTreeNode arrays. */
function trieToNodes(trie: TrieNode, parentPath: string): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];

  for (const [name, child] of trie.children) {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    // A node is a file if it was visited as a file. If it also has children
    // (impossible with real filesystem paths, but defensive), treat as file
    // and drop children — the activity record is the canonical signal.
    const isFile = child.activity !== null;

    const node: FileTreeNode = {
      name,
      // For files, use the original path for downstream lookups (shell_open, mascot matching).
      // For folders, use the reconstructed forward-slash path.
      fullPath: isFile && child.originalPath ? child.originalPath : fullPath,
      isFile,
      children: isFile ? [] : trieToNodes(child, fullPath),
      activity: child.activity,
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
