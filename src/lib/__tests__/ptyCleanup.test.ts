import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core before importing the module under test
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  registerActivePid,
  unregisterActivePid,
  killAllActivePtys,
} from "../ptyProcess";

const mockInvoke = vi.mocked(invoke);

describe("ptyCleanup", () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(undefined);
    // Clear internal Set by killing all (no-op if empty)
    killAllActivePtys();
    mockInvoke.mockReset().mockResolvedValue(undefined);
  });

  describe("registerActivePid", () => {
    it("calls invoke with register_active_pid", () => {
      registerActivePid(1234);
      expect(mockInvoke).toHaveBeenCalledWith("register_active_pid", {
        pid: 1234,
      });
    });

    it("does not throw if invoke rejects", () => {
      mockInvoke.mockRejectedValue(new Error("ipc down"));
      expect(() => registerActivePid(5678)).not.toThrow();
    });
  });

  describe("unregisterActivePid", () => {
    it("calls invoke with unregister_active_pid", () => {
      registerActivePid(1234);
      mockInvoke.mockReset().mockResolvedValue(undefined);
      unregisterActivePid(1234);
      expect(mockInvoke).toHaveBeenCalledWith("unregister_active_pid", {
        pid: 1234,
      });
    });

    it("does not throw for unregistered pid", () => {
      expect(() => unregisterActivePid(9999)).not.toThrow();
    });
  });

  describe("killAllActivePtys", () => {
    it("calls kill_process_tree for each registered pid", () => {
      registerActivePid(100);
      registerActivePid(200);
      registerActivePid(300);
      mockInvoke.mockReset().mockResolvedValue(undefined);

      killAllActivePtys();

      const killCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "kill_process_tree"
      );
      expect(killCalls).toHaveLength(3);
      const killedPids = killCalls.map(([, arg]) => (arg as { pid: number }).pid);
      expect(killedPids.sort()).toEqual([100, 200, 300]);
    });

    it("clears the registry after killing", () => {
      registerActivePid(100);
      mockInvoke.mockReset().mockResolvedValue(undefined);

      killAllActivePtys();
      expect(mockInvoke).toHaveBeenCalledTimes(1); // one kill

      mockInvoke.mockReset().mockResolvedValue(undefined);
      killAllActivePtys();
      expect(mockInvoke).not.toHaveBeenCalled(); // Set was cleared
    });

    it("does not invoke kill for unregistered pids", () => {
      registerActivePid(100);
      unregisterActivePid(100);
      mockInvoke.mockReset().mockResolvedValue(undefined);

      killAllActivePtys();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("does not throw on empty registry", () => {
      expect(() => killAllActivePtys()).not.toThrow();
    });

    it("handles duplicate registrations (Set deduplication)", () => {
      registerActivePid(42);
      registerActivePid(42);
      registerActivePid(42);
      mockInvoke.mockReset().mockResolvedValue(undefined);

      killAllActivePtys();

      const killCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "kill_process_tree"
      );
      expect(killCalls).toHaveLength(1);
    });
  });
});
