// zebra — team session store (team.json + history.jsonl)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryEvent, TeamConfig } from "./types.ts";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 会话目录：默认 <root>/sessions；测试可用 KRISTAL_SESSIONS_DIR 指到别处，
// 避免任何清理/冒烟测试碰到真实团队数据
export const SESSIONS_DIR = process.env.KRISTAL_SESSIONS_DIR
  ? path.resolve(process.env.KRISTAL_SESSIONS_DIR)
  : path.join(PROJECT_ROOT, "sessions");

export function listSessions(): TeamConfig[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out: TeamConfig[] = [];
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    const p = path.join(SESSIONS_DIR, dir, "team.json");
    try {
      if (fs.existsSync(p)) out.push(JSON.parse(fs.readFileSync(p, "utf8")) as TeamConfig);
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export function createSession(config: TeamConfig): TeamConfig {
  const dir = path.join(SESSIONS_DIR, config.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(config, null, 2));
  appendEvent(config.id, { t: new Date().toISOString(), type: "team_created", config });
  return config;
}

export function loadSession(id: string): TeamConfig {
  const p = path.join(SESSIONS_DIR, id, "team.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as TeamConfig;
}

export function saveTeamConfig(config: TeamConfig): void {
  const dir = sessionDir(config.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(config, null, 2));
}

export function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}

export function appendEvent(id: string, ev: HistoryEvent): void {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "history.jsonl"), JSON.stringify(ev) + "\n");
}

export function readEvents(id: string): HistoryEvent[] {
  const p = path.join(sessionDir(id), "history.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: HistoryEvent[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryEvent);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

/** Latest screen snapshot per member from the history — the team view at resume time. */
export function lastScreens(id: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const ev of readEvents(id)) {
    if (ev.type === "screen") map.set(ev.member, ev.lines);
  }
  return map;
}

export function newSessionId(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rnd = Math.random().toString(36).slice(2, 6);
  const safe = (name || "team").replace(/[^\w\-]+/g, "-").toLowerCase();
  return `${stamp}_${rnd}_${safe}`;
}
