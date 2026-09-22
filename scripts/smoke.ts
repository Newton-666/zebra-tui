// zebra smoke test — engine + storage, no TUI
import { createTeamSession, sendText, captureScreen, killSession, sessionAlive } from "../src/agents.ts";
import fs from "node:fs";
import { createSession, appendEvent, readEvents, lastScreens, sessionDir } from "../src/team.ts";
import type { TeamConfig } from "../src/types.ts";

const id = `smoke_${Date.now()}`;
const config: TeamConfig = {
  id,
  name: "smoke",
  createdAt: new Date().toISOString(),
  cwd: process.cwd(),
  tmuxSession: `zebra-${id}`,
  members: [
    { id: "a", name: "alpha", type: "custom", command: "cat", color: "36" },
    { id: "b", name: "beta", type: "custom", command: "cat", color: "35" },
  ],
};

const fail = (msg: string): never => {
  console.error("SMOKE FAIL:", msg);
  killSession(config.tmuxSession);
  process.exit(1);
};

// storage
createSession(config);
appendEvent(id, { t: new Date().toISOString(), type: "dispatch", to: ["a"], text: "hi a" });
appendEvent(id, { t: new Date().toISOString(), type: "screen", member: "a", lines: ["line1", "line2"] });
if (readEvents(id).length !== 3) fail("history events count");
const ls = lastScreens(id);
if (ls.get("a")?.join("|") !== "line1|line2") fail("lastScreens replay");

// tmux engine
const panes = createTeamSession(config);
if (panes.length !== 2) fail(`expected 2 panes, got ${panes.length}`);
if (!sessionAlive(config.tmuxSession)) fail("session not alive");
sendText(panes[0]!, "hello alpha");
sendText(panes[1]!, "hello beta");
await new Promise((r) => setTimeout(r, 400));
const scrA = captureScreen(panes[0]!);
const scrB = captureScreen(panes[1]!);
if (!scrA.join("\n").includes("hello alpha")) fail("alpha did not receive text");
if (!scrB.join("\n").includes("hello beta")) fail("beta did not receive text");
killSession(config.tmuxSession);
if (sessionAlive(config.tmuxSession)) fail("kill failed");

// 清理 smoke 会话目录（避免污染 zebra -c 的「最近会话」）
try {
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
} catch {}
console.log("SMOKE OK — storage ✓ engine ✓ dispatch ✓ capture ✓");
