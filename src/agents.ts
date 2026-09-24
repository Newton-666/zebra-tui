// zebra — tmux engine: create panes per member, dispatch, capture, sync
import { execFileSync } from "node:child_process";
import path from "node:path";
import { saveTeamConfig, sessionDir } from "./team.ts";
import { ensureKit } from "./kit.ts";
import { columnCount, LAYOUT_VERSION, type Member, type TeamConfig } from "./types.ts";

/** 成员窗格的环境：身份 + 会话工具包 PATH（`zebra roster/send/board` 可用） */
function envArgs(config: TeamConfig, member: Member): string[] {
  const home = sessionDir(config.id);
  const bin = path.join(home, "bin");
  const env: Record<string, string> = {
    ZEBRA_SESSION: config.id,
    ZEBRA_MEMBER: member.id,
    ZEBRA_HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  return args;
}

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"], // 不让 tmux 的报错漏到用户终端
    });
  } catch (e) {
    const target = args.includes("-t") ? args[args.indexOf("-t") + 1] : "";
    throw new Error(`tmux ${args[0]}${target ? ` -t ${target}` : ""} 失败: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { encoding: "utf8", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function sessionAlive(name: string): boolean {
  try {
    tmux(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

/** Create the tmux session with one pane per member. Returns pane ids in member order. */
export function createTeamSession(config: TeamConfig, commands?: string[]): string[] {
  const name = config.tmuxSession;
  if (sessionAlive(name)) killSession(name);
  ensureKit(config); // 生成 bin/krystal + BRIEF.md

  const cliIdx = config.members.map((m, i) => (m.type === "krystal" ? -1 : i)).filter((i) => i >= 0);
  const paneIds: string[] = config.members.map(() => ""); // 与 members 对齐；krystal 成员无窗格
  if (!cliIdx.length) {
    // 全原生团队：tmux 引擎室都不需要
    config.layoutVersion = LAYOUT_VERSION;
    config.paneIds = {};
    config.members.forEach((m) => (config.paneIds![m.id] = ""));
    saveTeamConfig(config);
    return paneIds;
  }

  const cmdOf = (mi: number) => commands?.[mi] ?? config.members[mi]!.command;
  const first = cliIdx[0]!;
  // -x/-y: detached 会话默认 80x24，split 后每格过小，部分 TUI 会直接退出
  tmux(["new-session", "-d", "-s", name, "-n", "agents", "-x", "220", "-y", "52", ...envArgs(config, config.members[first]!), "-c", config.cwd, cmdOf(first)]);

  const cols = columnCount(cliIdx.length);
  // 每个 pane 创建后立刻 remain-on-exit，命令秒退也不会破坏链路
  const firstId = tmux(["list-panes", "-t", name, "-F", "#{pane_id}"]).trim();
  paneIds[first] = firstId;
  tmux(["set-option", "-p", "-t", firstId, "remain-on-exit", "on"]);
  for (let k = 1; k < cliIdx.length; k++) {
    const mi = cliIdx[k]!;
    const anchor = k < cols ? paneIds[cliIdx[k - 1]!]! : paneIds[cliIdx[k - cols]!]!;
    const flags = k < cols ? ["-h"] : ["-v"];
    // 注意: -P -F 必须放在命令串之前，否则会被吞进命令里
    const out = tmux([
      "split-window",
      ...flags,
      ...envArgs(config, config.members[mi]!),
      "-t",
      anchor,
      "-c",
      config.cwd,
      "-P",
      "-F",
      "#{pane_id}",
      cmdOf(mi),
    ]);
    const id = out.trim();
    if (!id) throw new Error(`split-window 未返回 pane id (成员 ${config.members[mi]!.name})`);
    paneIds[mi] = id;
    tmux(["set-option", "-p", "-t", id, "remain-on-exit", "on"]);
  }
  config.members.forEach((m, i) => {
    if (!paneIds[i]) return;
    try {
      tmux(["select-pane", "-t", paneIds[i], "-T", `zebra:${m.name}`]);
    } catch {
      /* non-fatal */
    }
  });
  // 创建完成校验：任何秒退的成员当场复活一次
  cliIdx.forEach((mi) => {
    if (!paneAlive(paneIds[mi]!)) {
      try {
        respawnPane(config, config.members[mi]!, paneIds[mi]!);
      } catch {
        /* poller 会继续重试 */
      }
    }
  });
  // 持久化 member→pane 映射（resume 时顺序稳定）
  config.layoutVersion = LAYOUT_VERSION;
  config.paneIds = {};
  config.members.forEach((m, i) => {
    config.paneIds![m.id] = paneIds[i]!;
  });
  saveTeamConfig(config);
  return paneIds;
}

export function ensureTeamSession(config: TeamConfig, useResume: boolean): string[] {
  const name = config.tmuxSession;
  const cliCount = config.members.filter((m) => m.type !== "krystal").length;
  const aligned = (): string[] => config.members.map((m) => config.paneIds?.[m.id] ?? "");
  // 排布规则升级 → 引擎窗格与网格不再对齐，重建一次（成员用各自的 resume 命令，上下文由 agent 自身持久化）
  if (config.layoutVersion !== LAYOUT_VERSION && sessionAlive(name)) killSession(name);
  if (sessionAlive(name)) {
    if (config.paneIds) {
      // 1) 持久化映射且覆盖全员、cli 窗格全部存活 → 直接用
      const mapped = aligned();
      const cliPanes = mapped.filter(Boolean);
      if (mapped.length === config.members.length && cliPanes.length === cliCount && mapped.every((p) => !p || paneAlive(p))) return mapped;
    }
    // 2) 现有窗格数 = cli 成员数且全部存活 → 用之并回写映射
    const listed = tmux(["list-panes", "-t", name, "-F", "#{pane_id}"]).trim().split("\n").filter(Boolean);
    if (listed.length === cliCount && listed.every((id) => paneAlive(id))) {
      config.paneIds = {};
      config.members.filter((m) => m.type !== "krystal").forEach((m, i) => {
        config.paneIds![m.id] = listed[i]!;
      });
      config.members.filter((m) => m.type === "krystal").forEach((m) => {
        config.paneIds![m.id] = "";
      });
      saveTeamConfig(config);
      return aligned();
    }
    // 3) 窗格缺失/死亡 → 整体重建（成员各自用 resume 命令拉起）
    killSession(name);
  }
  if (useResume) {
    // 就地重建：paneIds 写回原 config（调用方要用），config.members 的原始启动命令保持不变
    const resumeCommands = config.members.map((m) => m.resumeCommand || m.command);
    return createTeamSession(config, resumeCommands);
  }
  return createTeamSession(config);
}

export function killSession(name: string): void {
  try {
    tmux(["kill-session", "-t", name]);
  } catch {
    /* already gone */
  }
}

export function sendText(paneId: string, text: string): void {
  tmux(["send-keys", "-t", paneId, "-l", "--", text]);
  tmux(["send-keys", "-t", paneId, "Enter"]);
}

export function sendRaw(paneId: string, keys: string[]): void {
  tmux(["send-keys", "-t", paneId, ...keys]);
}

/** Capture the pane's visible screen (ANSI colors preserved). */
export function captureScreen(paneId: string, historyLines = 0): string[] {
  // historyLines > 0 时连同滚动历史一起抓（-S -N）
  const args = ["capture-pane", "-p", "-e"];
  if (historyLines > 0) args.push("-S", `-${historyLines}`);
  args.push("-t", paneId);
  const out = tmux(args);
  const lines = out.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

export function paneAlive(paneId: string): boolean {
  try {
    // remain-on-exit 下死窗格对象仍存在，必须检查 pane_dead 标志
    const out = tmux(["display-message", "-p", "-t", paneId, "#{pane_dead}"]);
    return out.trim() === "0";
  } catch {
    return false;
  }
}

/** Revive a dead (remain-on-exit) pane with the member's command（保留身份环境）. */
export function respawnPane(config: TeamConfig, member: Member, paneId: string): void {
  const command = member.resumeCommand || member.command;
  tmux(["respawn-pane", "-k", ...envArgs(config, member), "-t", paneId, command]);
}

/** Sync engine panes to grid geometry: resize window, then set first-column pane width. */
export function syncPaneWidths(
  config: TeamConfig,
  paneIds: string[],
  geometry: { colWidths: number[]; width: number; height: number },
): void {
  const name = config.tmuxSession;
  if (!sessionAlive(name)) return;
  try {
    tmux(["resize-window", "-t", name, "-x", String(Math.max(80, Math.floor(geometry.width))), "-y", String(Math.max(24, Math.floor(geometry.height)))]);
  } catch {
    /* 尽力而为 */
  }
  if (geometry.colWidths.length === 2) {
    // 两列：调整第一列锚点窗格宽度，第二列自动获得剩余宽度
    const firstColMember = config.members.find((_m, i) => i % 2 === 0);
    const idx = config.members.indexOf(firstColMember!);
    const paneId = paneIds[idx];
    if (paneId) {
      try {
        tmux(["resize-pane", "-t", paneId, "-x", String(Math.max(10, Math.floor(geometry.colWidths[0]!)))]);
      } catch {
        /* 尽力而为 */
      }
    }
  }
}
