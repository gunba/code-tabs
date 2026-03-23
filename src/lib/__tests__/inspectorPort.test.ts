import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// Mock @tauri-apps/api/core — allocateInspectorPort calls invoke("check_port_available")
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));

const mockInvoke = vi.mocked(invoke);

import {
  allocateInspectorPort,
  registerInspectorPort,
  unregisterInspectorPort,
  getInspectorPort,
  registerInspectorCallbacks,
  unregisterInspectorCallbacks,
  disconnectInspectorForSession,
  reconnectInspectorForSession,
} from "../inspectorPort";

// NOTE: allocateInspectorPort has existing tests in inspectorHooks.test.ts.
// These tests cover the port registry and callback registry.

const S1 = "session-1";
const S2 = "session-2";

describe("inspectorPort registry", () => {
  beforeEach(() => {
    // Clean up any state from previous tests
    unregisterInspectorPort(S1);
    unregisterInspectorPort(S2);
    unregisterInspectorCallbacks(S1);
    unregisterInspectorCallbacks(S2);
  });

  // ── Port registry ─────────────────────────────────────────────────

  describe("port registry", () => {
    it("returns null for unregistered session", () => {
      expect(getInspectorPort("nonexistent")).toBeNull();
    });

    it("registers and retrieves a port", () => {
      registerInspectorPort(S1, 6400);
      expect(getInspectorPort(S1)).toBe(6400);
    });

    it("overwrites port on re-register", () => {
      registerInspectorPort(S1, 6400);
      registerInspectorPort(S1, 6410);
      expect(getInspectorPort(S1)).toBe(6410);
    });

    it("unregister removes the port", () => {
      registerInspectorPort(S1, 6400);
      unregisterInspectorPort(S1);
      expect(getInspectorPort(S1)).toBeNull();
    });

    it("unregistering a non-existent session does not throw", () => {
      expect(() => unregisterInspectorPort("nonexistent")).not.toThrow();
    });

    it("tracks multiple sessions independently", () => {
      registerInspectorPort(S1, 6400);
      registerInspectorPort(S2, 6401);
      expect(getInspectorPort(S1)).toBe(6400);
      expect(getInspectorPort(S2)).toBe(6401);
      unregisterInspectorPort(S1);
      expect(getInspectorPort(S1)).toBeNull();
      expect(getInspectorPort(S2)).toBe(6401);
    });
  });

  // ── Callback registry & disconnect/reconnect ─────────────────────

  describe("disconnect and reconnect", () => {
    it("disconnect calls the disconnect callback", () => {
      const disconnect = vi.fn();
      const reconnect = vi.fn();
      registerInspectorCallbacks(S1, { disconnect, reconnect });

      disconnectInspectorForSession(S1);

      expect(disconnect).toHaveBeenCalledOnce();
      expect(reconnect).not.toHaveBeenCalled();
    });

    it("reconnect calls the reconnect callback", () => {
      const disconnect = vi.fn();
      const reconnect = vi.fn();
      registerInspectorCallbacks(S1, { disconnect, reconnect });

      reconnectInspectorForSession(S1);

      expect(reconnect).toHaveBeenCalledOnce();
      expect(disconnect).not.toHaveBeenCalled();
    });

    it("disconnect on session with no callbacks does not throw", () => {
      expect(() => disconnectInspectorForSession("nonexistent")).not.toThrow();
    });

    it("reconnect on session with no callbacks does not throw", () => {
      expect(() => reconnectInspectorForSession("nonexistent")).not.toThrow();
    });

    it("unregisterInspectorCallbacks prevents future disconnect/reconnect calls", () => {
      const disconnect = vi.fn();
      const reconnect = vi.fn();
      registerInspectorCallbacks(S1, { disconnect, reconnect });
      unregisterInspectorCallbacks(S1);

      disconnectInspectorForSession(S1);
      reconnectInspectorForSession(S1);

      expect(disconnect).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
    });
  });

  // ── Integration: full lifecycle ───────────────────────────────────

  describe("full lifecycle", () => {
    it("register → disconnect → reconnect → unregister", async () => {
      const disconnect = vi.fn();
      const reconnect = vi.fn();

      // 1. Register port and callbacks
      const port = await allocateInspectorPort();
      registerInspectorPort(S1, port);
      registerInspectorCallbacks(S1, { disconnect, reconnect });
      expect(getInspectorPort(S1)).toBe(port);

      // 2. Disconnect (e.g., user opens external debugger)
      disconnectInspectorForSession(S1);
      expect(disconnect).toHaveBeenCalledOnce();

      // 3. Reconnect (e.g., user closes external debugger)
      reconnectInspectorForSession(S1);
      expect(reconnect).toHaveBeenCalledOnce();

      // 4. Unregister (session closed)
      unregisterInspectorPort(S1);
      unregisterInspectorCallbacks(S1);
      expect(getInspectorPort(S1)).toBeNull();

      // 5. Callbacks should not be called after unregister
      disconnectInspectorForSession(S1);
      reconnectInspectorForSession(S1);
      expect(disconnect).toHaveBeenCalledOnce(); // still 1
      expect(reconnect).toHaveBeenCalledOnce(); // still 1
    });

    it("respawn lifecycle: unregister + re-register works cleanly", async () => {
      const disconnect = vi.fn();
      registerInspectorCallbacks(S1, { disconnect, reconnect: vi.fn() });
      registerInspectorPort(S1, 6400);

      // User disconnects inspector
      disconnectInspectorForSession(S1);

      // Session respawns: unregister old, register new
      unregisterInspectorPort(S1);
      unregisterInspectorCallbacks(S1);

      // Re-register with new port (simulating respawn)
      const newPort = await allocateInspectorPort();
      registerInspectorPort(S1, newPort);
      const newDisconnect = vi.fn();
      const newReconnect = vi.fn();
      registerInspectorCallbacks(S1, { disconnect: newDisconnect, reconnect: newReconnect });

      // New inspector should work without needing reconnect first
      expect(getInspectorPort(S1)).toBe(newPort);
      disconnectInspectorForSession(S1);
      expect(newDisconnect).toHaveBeenCalledOnce();
    });
  });

  // ── allocateInspectorPort edge cases ──────────────────────────────

  describe("allocateInspectorPort", () => {
    beforeEach(() => {
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValue(true);
    });

    it("calls invoke('check_port_available') with the candidate port", async () => {
      mockInvoke.mockResolvedValue(true);
      const port = await allocateInspectorPort();
      expect(mockInvoke).toHaveBeenCalledWith("check_port_available", { port });
    });

    it("skips ports already in the registry", async () => {
      // Allocate a port to learn the current cursor position
      mockInvoke.mockResolvedValue(true);
      const first = await allocateInspectorPort();
      // Register it as "in use"
      registerInspectorPort("blocker", first);

      // Next allocation should skip `first` without probing it
      mockInvoke.mockClear();
      const second = await allocateInspectorPort();
      expect(second).not.toBe(first);
      // The skipped port should not have been probed
      const probedPorts = mockInvoke.mock.calls.map(c => (c[1] as { port: number }).port);
      expect(probedPorts).not.toContain(first);

      // Cleanup
      unregisterInspectorPort("blocker");
    });

    it("skips ports where check_port_available returns false", async () => {
      // First candidate will be OS-occupied, second will be free
      mockInvoke
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const port = await allocateInspectorPort();
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      // Returned port is the second candidate (the free one)
      const secondProbed = (mockInvoke.mock.calls[1]![1] as { port: number }).port;
      expect(port).toBe(secondProbed);
    });

    it("throws when all ports are exhausted", async () => {
      // Fill the entire range via OS probe returning false
      mockInvoke.mockResolvedValue(false);
      await expect(allocateInspectorPort()).rejects.toThrow(
        "No free inspector ports in range 6400-6499"
      );
    });
  });
});
