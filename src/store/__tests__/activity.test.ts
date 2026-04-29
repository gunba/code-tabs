import { describe, it, expect, beforeEach } from "vitest";
import { useActivityStore } from "../activity";

const SID = "s1";

function reset() {
  useActivityStore.setState({ sessions: {} });
  useActivityStore.getState().startTurn(SID, "t1");
}

describe("activity store", () => {
  beforeEach(reset);

  describe("create+delete suppression", () => {
    it("drops a file created then deleted in the same turn", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/a.txt", "created", { toolName: "Bash" });
      store.addFileActivity(SID, "/p/a.txt", "deleted", { toolName: "Bash" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files).toEqual([]);
      expect(activity.allFiles["/p/a.txt"]).toBeUndefined();
      expect(activity.visitedPaths.has("/p/a.txt")).toBe(false);
      expect(activity.stats.filesCreated).toBe(0);
      expect(activity.stats.filesDeleted).toBe(0);
    });

    it("retains a deleted entry when no matching create exists in the turn", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/existing.txt", "deleted", { toolName: "Bash" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files.length).toBe(1);
      expect(activity.turns[0].files[0].kind).toBe("deleted");
    });

    it("does not suppress when the prior kind is modified rather than created", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/a.txt", "modified", { toolName: "Edit" });
      store.addFileActivity(SID, "/p/a.txt", "deleted", { toolName: "Bash" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files.length).toBe(1);
      expect(activity.turns[0].files[0].kind).toBe("deleted");
    });
  });

  describe("file activity precedence", () => {
    it("keeps created when the same path is later modified", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/new.txt", "created", { toolName: "Write" });
      store.addFileActivity(SID, "/p/new.txt", "modified", { toolName: "Edit" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files[0].kind).toBe("created");
      expect(activity.allFiles["/p/new.txt"].kind).toBe("created");
    });

    it("does not downgrade a real change to read", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/edit.txt", "modified", { toolName: "Edit" });
      store.addFileActivity(SID, "/p/edit.txt", "read", { toolName: "Read" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files[0].kind).toBe("modified");
      expect(activity.allFiles["/p/edit.txt"].kind).toBe("modified");
    });

    it("does not downgrade a real change to searched in allFiles", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/edit.txt", "modified", { toolName: "Edit", agentId: null });
      store.addFileActivity(SID, "/p/edit.txt", "searched", { toolName: "Glob", agentId: "agent-1" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files[0].kind).toBe("modified");
      expect(activity.allFiles["/p/edit.txt"].kind).toBe("modified");
      expect(activity.allFiles["/p/edit.txt"].agentId).toBe("agent-1");
    });

    it("keeps main-agent searched entries over subagent searches", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/search.txt", "searched", { toolName: "Glob", agentId: null });
      store.addFileActivity(SID, "/p/search.txt", "searched", { toolName: "Glob", agentId: "agent-1" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files[0].agentId).toBeNull();
      expect(activity.allFiles["/p/search.txt"].agentId).toBeNull();
    });

    it("lets main-agent searched entries replace subagent searches", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/search.txt", "searched", { toolName: "Glob", agentId: "agent-1" });
      store.addFileActivity(SID, "/p/search.txt", "searched", { toolName: "Glob", agentId: null });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files[0].agentId).toBeNull();
      expect(activity.allFiles["/p/search.txt"].agentId).toBeNull();
    });

    it("does not lose known folder status when later activity omits folder metadata", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/Folder With Spaces", "searched", {
        toolName: "Glob",
        isFolder: true,
      });
      store.addFileActivity(SID, "/p/Folder With Spaces", "read", { toolName: "Read" });

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files[0].isFolder).toBe(true);
      expect(activity.allFiles["/p/Folder With Spaces"].isFolder).toBe(true);
    });
  });

  describe("confirmEntries", () => {
    it("removes a created entry that does not exist on disk", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/phantom.txt", "created", { toolName: "Bash" });
      store.confirmEntries(SID, [
        { path: "/p/phantom.txt", exists: false, isDir: false },
      ]);

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files).toEqual([]);
      expect(activity.allFiles["/p/phantom.txt"]).toBeUndefined();
      expect(activity.visitedPaths.has("/p/phantom.txt")).toBe(false);
    });

    it("removes a deleted entry that still exists on disk", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/notdeleted.txt", "deleted", { toolName: "Bash" });
      store.confirmEntries(SID, [
        { path: "/p/notdeleted.txt", exists: true, isDir: false },
      ]);

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files).toEqual([]);
    });

    it("keeps a created entry whose path exists and marks it confirmed", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/real.txt", "created", { toolName: "Bash" });
      store.confirmEntries(SID, [
        { path: "/p/real.txt", exists: true, isDir: false },
      ]);

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files.length).toBe(1);
      expect(activity.turns[0].files[0].confirmed).toBe(true);
      expect(activity.allFiles["/p/real.txt"].confirmed).toBe(true);
    });

    it("updates isFolder based on stat result", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/was-thought-a-file", "created", { toolName: "Bash" });
      store.confirmEntries(SID, [
        { path: "/p/was-thought-a-file", exists: true, isDir: true },
      ]);

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.allFiles["/p/was-thought-a-file"].isFolder).toBe(true);
    });

    it("keeps a deleted entry whose path is actually gone", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/gone.txt", "deleted", { toolName: "Bash" });
      store.confirmEntries(SID, [
        { path: "/p/gone.txt", exists: false, isDir: false },
      ]);

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files.length).toBe(1);
      expect(activity.turns[0].files[0].kind).toBe("deleted");
    });

    it("ignores paths not in the results map", () => {
      const store = useActivityStore.getState();
      store.addFileActivity(SID, "/p/a.txt", "created", { toolName: "Bash" });
      store.addFileActivity(SID, "/p/b.txt", "created", { toolName: "Bash" });
      store.confirmEntries(SID, [
        { path: "/p/a.txt", exists: true, isDir: false },
      ]);

      const activity = useActivityStore.getState().sessions[SID];
      expect(activity.turns[0].files.length).toBe(2);
    });
  });
});
