/**
 * Reproduce: revive a dead session with long history.
 * Monitor feed entries and terminal state second by second.
 */
const { execSync, spawn } = require("child_process");
const path = require("path");
const { readState, sendCommand, waitForState, sleep } = require("./test-bridge.cjs");

const EXE = path.join(__dirname, "..", "src-tauri", "target", "release", "claude-tabs.exe");
function killApp() { try { execSync("taskkill /IM claude-tabs.exe /F", { stdio: "ignore" }); } catch {} }

function main() {
  console.log("=== Revive + Monitor Test ===\n");
  killApp(); sleep(2000);
  spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();

  const init = waitForState((s) => s.initialized, 15000);
  if (!init) { console.log("FAIL: No init"); killApp(); process.exit(1); }

  const dead = init.sessions.find((s) => s.state === "dead" && s.assistantMessageCount > 10);
  if (!dead) { console.log("No dead session with history to test"); killApp(); process.exit(0); }
  console.log("Dead session:", dead.name, "msgs:", dead.assistantMessageCount, "id:", dead.id.slice(0, 8));

  // Wait for claudePath
  waitForState((s) => s.claudePath, 15000);
  sleep(1000);

  console.log("\nReviving...");
  sendCommand({ action: "reviveSession", args: { id: dead.id } });

  // Monitor every second for 60s
  console.log("\nMonitoring (1s intervals):");
  let prevFeed = 0;
  let prevState = "";
  for (let i = 0; i < 60; i++) {
    sleep(1000);
    const s = readState();
    if (!s) continue;

    const feedCount = s.feedEntryCount ?? 0;
    const feedDelta = feedCount - prevFeed;

    // Find the revived session (newest non-dead)
    const live = s.sessions.find((x) => x.state !== "dead");
    const st = live?.state ?? "?";

    if (feedDelta > 0 || st !== prevState) {
      console.log(`+${i+1}s  state=${st}  feed=${feedCount} (+${feedDelta})  msgs=${live?.assistantMessageCount ?? 0}`);
      if (feedDelta > 0 && s.feedLastEntry) {
        console.log(`  lastEntry: [${s.feedLastEntry.type}] ${JSON.stringify(s.feedLastEntry.message).slice(0, 80)}`);
      }
    }

    prevFeed = feedCount;
    prevState = st;

    // Stop if we've seen the session go idle and feed has stabilized
    if (st === "idle" && i > 30 && feedDelta === 0) break;
  }

  const final = readState();
  console.log("\n=== Final ===");
  console.log("Feed entries:", final?.feedEntryCount);
  console.log("Tracking:", JSON.stringify(final?.feedTracking));

  if (final?.feedEntryCount > 0) {
    console.log("\n✗ ISSUE: Feed has", final.feedEntryCount, "entries from replay");
  } else {
    console.log("\n✓ Feed clean — no replay entries");
  }

  // Cleanup
  const live = final?.sessions.find((x) => x.state !== "dead");
  if (live) sendCommand({ action: "closeSession", args: { id: live.id } });
  sleep(3000);
  killApp();
}

main();
