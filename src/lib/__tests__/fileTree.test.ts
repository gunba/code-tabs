import { describe, it, expect } from "vitest";
import { buildFileTree, flattenTree, allFolderPaths } from "../fileTree";
import type { FileActivity } from "../../types/activity";

function makeActivity(path: string, kind: "read" | "modified" | "created" = "read"): FileActivity {
  return {
    path,
    kind,
    agentId: null,
    toolName: "Read",
    timestamp: Date.now(),
    confirmed: true,
    isExternal: false,
    permissionDenied: false,
    permissionMode: null,
    toolInputData: null,
  };
}

function toMap(entries: FileActivity[]): Map<string, FileActivity> {
  return new Map(entries.map((e) => [e.path, e]));
}

/** Recursively find a node by name in the tree. */
function findNode(
  nodes: { name: string; children: { name: string; children: any[]; isFile: boolean; isWorkspaceRoot: boolean }[]; isFile: boolean; isWorkspaceRoot: boolean }[],
  name: string,
): typeof nodes[0] | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    const found = findNode(n.children, name);
    if (found) return found;
  }
  return undefined;
}

/** Collect all leaf file names from a tree. */
function allFileNames(
  nodes: { name: string; children: any[]; isFile: boolean }[],
): string[] {
  const names: string[] = [];
  for (const n of nodes) {
    if (n.isFile) names.push(n.name);
    else names.push(...allFileNames(n.children));
  }
  return names.sort();
}

describe("buildFileTree", () => {
  it("returns empty array for empty input", () => {
    expect(buildFileTree(new Map(), "/workspace")).toEqual([]);
  });

  it("builds a unified tree with workspace root marked", () => {
    const files = toMap([
      makeActivity("/workspace/src/app.ts"),
      makeActivity("/workspace/src/utils.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    // Find the workspace node (may be at root or nested)
    const wsNode = findNode(tree, "workspace");
    expect(wsNode).toBeDefined();
    expect(wsNode!.isWorkspaceRoot).toBe(true);

    // Files should be reachable
    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["app.ts", "utils.ts"]);
  });

  it("preserves original full paths for file nodes (needed for shell_open)", () => {
    const files = toMap([makeActivity("/workspace/src/app.ts")]);
    const tree = buildFileTree(files, "/workspace");

    // Navigate to the file leaf
    let node = tree[0];
    while (!node.isFile && node.children.length > 0) {
      node = node.children[0];
    }
    expect(node.isFile).toBe(true);
    expect(node.fullPath).toBe("/workspace/src/app.ts");
  });

  it("compresses single-child directory chains (compact folders)", () => {
    const files = toMap([
      makeActivity("/workspace/src/components/Panel/ActivityPanel.tsx"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    // Find the file
    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["ActivityPanel.tsx"]);

    // Workspace root must be a distinct node (not compressed away)
    const wsNode = findNode(tree, "workspace");
    expect(wsNode).toBeDefined();
    expect(wsNode!.isWorkspaceRoot).toBe(true);
  });

  it("does not compress through workspace root", () => {
    const files = toMap([
      makeActivity("/a/workspace/src/app.ts"),
    ]);
    const tree = buildFileTree(files, "/a/workspace");

    // The workspace node must be visible and marked
    const wsNode = findNode(tree, "workspace");
    expect(wsNode).toBeDefined();
    expect(wsNode!.isWorkspaceRoot).toBe(true);
    expect(wsNode!.isFile).toBe(false);
  });

  it("does not compress directories with multiple children", () => {
    const files = toMap([
      makeActivity("/workspace/src/a.ts"),
      makeActivity("/workspace/src/b.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    const srcNode = findNode(tree, "src");
    expect(srcNode).toBeDefined();
    expect(srcNode!.children).toHaveLength(2);
  });

  it("places workspace and external files in one unified tree", () => {
    const files = toMap([
      makeActivity("/workspace/src/app.ts"),
      makeActivity("/external/lib/helper.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    // All files should be reachable from the single tree
    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["app.ts", "helper.ts"]);

    // Workspace root should be marked
    const wsNode = findNode(tree, "workspace");
    expect(wsNode).toBeDefined();
    expect(wsNode!.isWorkspaceRoot).toBe(true);
  });

  it("handles multiple external files with shared prefix alongside workspace", () => {
    const files = toMap([
      makeActivity("/workspace/src/app.ts"),
      makeActivity("/external/lib/a.ts"),
      makeActivity("/external/lib/b.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["a.ts", "app.ts", "b.ts"]);
  });

  it("handles Windows paths with backslashes", () => {
    const files = toMap([
      makeActivity("C:\\Users\\jorda\\project\\src\\app.ts"),
    ]);
    const tree = buildFileTree(files, "C:\\Users\\jorda\\project");

    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["app.ts"]);

    // Workspace root should be marked
    const wsNode = findNode(tree, "project");
    expect(wsNode).toBeDefined();
    expect(wsNode!.isWorkspaceRoot).toBe(true);

    // Original path preserved for shell_open
    let node = tree[0];
    while (!node.isFile && node.children.length > 0) {
      node = node.children[0];
    }
    expect(node.fullPath).toBe("C:\\Users\\jorda\\project\\src\\app.ts");
  });

  it("sorts folders before files", () => {
    const files = toMap([
      makeActivity("/workspace/file.ts"),
      makeActivity("/workspace/subdir/other.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    const wsNode = findNode(tree, "workspace");
    expect(wsNode).toBeDefined();
    expect(wsNode!.children).toHaveLength(2);
    // subdir (folder) should come before file.ts (file)
    expect(wsNode!.children[0].name).toBe("subdir");
    expect(wsNode!.children[0].isFile).toBe(false);
    expect(wsNode!.children[1].name).toBe("file.ts");
    expect(wsNode!.children[1].isFile).toBe(true);
  });

  it("handles files at different depths", () => {
    const files = toMap([
      makeActivity("/workspace/a/b/c/deep.ts"),
      makeActivity("/workspace/a/shallow.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["deep.ts", "shallow.ts"]);
  });

  it("normalizes mixed separator paths to avoid duplicates", () => {
    const files = toMap([
      makeActivity("C:/Users/jorda/project/a.ts"),
    ]);
    const tree = buildFileTree(files, "C:\\Users\\jorda\\project");

    const fileNames = allFileNames(tree);
    expect(fileNames).toEqual(["a.ts"]);

    const wsNode = findNode(tree, "project");
    expect(wsNode).toBeDefined();
    expect(wsNode!.isWorkspaceRoot).toBe(true);
  });

  it("marks isWorkspaceRoot=false on non-workspace folders", () => {
    const files = toMap([
      makeActivity("/workspace/src/app.ts"),
      makeActivity("/other/lib/helper.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");

    // Check that only the workspace node is marked
    function checkWsRoot(nodes: any[]): number {
      let count = 0;
      for (const n of nodes) {
        if (n.isWorkspaceRoot) count++;
        count += checkWsRoot(n.children);
      }
      return count;
    }
    expect(checkWsRoot(tree)).toBe(1);
  });
});

describe("flattenTree", () => {
  it("flattens all nodes when all folders expanded", () => {
    const files = toMap([
      makeActivity("/workspace/a/b.ts"),
      makeActivity("/workspace/c.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");
    const expanded = allFolderPaths(tree);
    const rows = flattenTree(tree, expanded);

    // Should contain at least workspace, a, b.ts, c.ts
    const fileRows = rows.filter((r) => r.node.isFile);
    expect(fileRows).toHaveLength(2);
  });

  it("hides children of collapsed folders", () => {
    const files = toMap([
      makeActivity("/workspace/a/b/c.ts"),
      makeActivity("/workspace/a/d.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");
    // Only expand the root node(s), not deeper folders
    const expanded = new Set([tree[0].fullPath]);
    const rows = flattenTree(tree, expanded);

    // Root + one collapsed child
    expect(rows.length).toBeLessThanOrEqual(3);
  });
});

describe("allFolderPaths", () => {
  it("collects all non-file paths", () => {
    const files = toMap([
      makeActivity("/workspace/x/y/z.ts"),
      makeActivity("/workspace/x/w.ts"),
    ]);
    const tree = buildFileTree(files, "/workspace");
    const paths = allFolderPaths(tree);

    // Should have at least workspace root + x + y
    expect(paths.size).toBeGreaterThanOrEqual(3);
  });
});
