// Krystal — 团队工具包：为每个成员生成会话内协作命令（krystal）+ 团队简报（BRIEF.md）
// 成员在自己终端里执行 krystal roster / send / board，即可感知队友并互通消息
import fs from "node:fs";
import path from "node:path";
import { sessionDir } from "./team.ts";
import type { TeamConfig } from "./types.ts";

const HELPER = `#!/usr/bin/env node
// krystal — Krystal 团队内协作工具（由 Krystal 生成，成员在自己终端里使用）
// 注意：会话目录位于项目内（package.json type=module），因此使用 ESM 语法
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = process.env.ZEBRA_HOME;
const ME = process.env.ZEBRA_MEMBER || "unknown";
if (!HOME) {
  console.error("krystal: 缺少 ZEBRA_HOME（请从 Krystal 启动的成员窗格内运行）");
  process.exit(1);
}
const cfgPath = path.join(HOME, "team.json");
const boardPath = path.join(HOME, "board.md");
const relayPath = path.join(HOME, "last-relay");

function cfg() {
  if (!fs.existsSync(cfgPath)) {
    console.error("krystal: 找不到团队配置 " + cfgPath + "（会话可能已删除）");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}
function tmux(args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 });
  } catch (e) {
    return null;
  }
}
function me(c) {
  return c.members.find((m) => m.id === ME || m.name === ME) || { id: ME, name: ME, type: "?" };
}
function paneAlive(id) {
  const out = tmux(["display-message", "-p", "-t", id, "#{pane_dead}"]);
  return out !== null && out.trim() === "0";
}
function appendHistory(ev) {
  try {
    fs.appendFileSync(path.join(HOME, "history.jsonl"), JSON.stringify(ev) + "\\n");
  } catch {}
}

function cmdWhoami(c) {
  const m = me(c);
  console.log(\`团队「\${c.name}」成员：\${m.name}（类型 \${m.type}）\`);
  console.log(\`队友：\${c.members.filter((x) => x.id !== m.id).map((x) => x.name).join("、") || "（无）"}\`);
}

function cmdRoster(c) {
  const self = me(c);
  console.log(\`团队「\${c.name}」（\${c.members.length} 名成员）\`);
  for (const m of c.members) {
    const pane = c.paneIds && c.paneIds[m.id];
    const alive = pane ? (paneAlive(pane) ? "● 在线" : "× 已退出") : "? 无窗格";
    const tag = m.id === self.id ? "（你）" : "";
    console.log(\`  \${m.name.padEnd(10)} \${String(m.type).padEnd(8)} \${alive}\${tag}\`);
  }
}

function recentRelays(windowMs) {
  try {
    const lines = fs.readFileSync(path.join(HOME, "history.jsonl"), "utf8").trim().split("\\n");
    const now = Date.now();
    let total = 0;
    const pairs = {};
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 500; i--) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.type !== "relay") continue;
      const t = Date.parse(e.t);
      if (!t || now - t > windowMs) continue;
      total++;
      const k = e.from + "→" + e.to;
      pairs[k] = (pairs[k] || 0) + 1;
    }
    return { total, pairs };
  } catch {
    return { total: 0, pairs: {} };
  }
}

function cmdSend(c, args) {
  const name = args[0];
  const text = args.slice(1).join(" ").trim();
  if (!name || !text) {
    console.error("用法: krystal send <队友名> <消息>");
    process.exit(2);
  }
  const self = me(c);
  const target = c.members.find((m) => m.name === name || m.id === name);
  if (!target) {
    console.error(\`找不到队友「\${name}」，可用：\${c.members.map((m) => m.name).join("、")}\`);
    process.exit(2);
  }
  const pane = c.paneIds && c.paneIds[target.id];
  if (!pane) {
    console.error(\`队友「\${target.name}」没有可用的窗格（请让 Krystal 执行 :team 重建）\`);
    process.exit(1);
  }
  if (!paneAlive(pane)) {
    console.error(\`队友「\${target.name}」的窗格已退出（请让 Krystal 执行 :team 重建）\`);
    process.exit(1);
  }
  // 循环保护：短时间内互发过多 → 阻止（疑似「互相确认」死循环）
  const { total, pairs } = recentRelays(60000);
  const pairCount = pairs[self.name + "→" + target.name] || 0;
  if (total >= 6 || pairCount >= 3) {
    console.error(
      "krystal: 已阻止发送 —— 60 秒内互助消息过多（疑似确认循环）。\\n" +
        "  建议：结论写白板（krystal board <内容>），或等人类在 Krystal 里介入；\\n" +
        "  确有实质新信息时，请稍等 1 分钟再发。",
    );
    appendHistory({
      t: new Date().toISOString(),
      type: "note",
      text: \`已阻止 \${self.name} → \${target.name} 的发送（频率保护：60s 内 \${total} 条 / 本对 \${pairCount} 条）\`,
    });
    process.exit(3);
  }
  const line = \`[from \${self.name}] \${text}\`;
  tmux(["send-keys", "-t", pane, "-l", "--", line]);
  tmux(["send-keys", "-t", pane, "Enter"]);
  const stamp = new Date().toISOString();
  appendHistory({ t: stamp, type: "relay", from: self.name, to: target.name, text });
  try {
    fs.writeFileSync(relayPath, \`\${self.name} → \${target.name}: \${text}\`);
  } catch {}
  console.log(\`已发送给 \${target.name}: \${text}\`);
}

function cmdBoard(_c, args) {
  if (args.length > 0) {
    const self = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const m = me(self);
    const entry = \`- [\${new Date().toISOString().slice(0, 16).replace("T", " ")}] \${m.name}: \${args.join(" ")}\`;
    fs.appendFileSync(boardPath, entry + "\\n");
    appendHistory({ t: new Date().toISOString(), type: "note", text: \`白板追加（\${m.name}）: \${args.join(" ")}\` });
    console.log("已追加到团队白板");
    return;
  }
  if (!fs.existsSync(boardPath)) {
    console.log("（团队白板还是空的，用 krystal board <内容> 追加）");
    return;
  }
  console.log(fs.readFileSync(boardPath, "utf8").trimEnd());
}

function cmdHelp() {
  console.log(\`krystal — Krystal 团队协作命令
  krystal whoami                确认自己的身份
  krystal roster                查看队友与在线状态
  krystal send <队友> <消息>     给队友发消息（出现在对方会话，前缀 [from 你]）
  krystal board [内容]           查看 / 追加团队白板（异步协作）
  krystal help                  本帮助\`);
}

const [, , cmd, ...args] = process.argv;
const c = cfg();
switch (cmd) {
  case undefined:
  case "help":
  case "-h":
    cmdHelp();
    break;
  case "whoami":
    cmdWhoami(c);
    break;
  case "roster":
    cmdRoster(c);
    break;
  case "send":
    cmdSend(c, args);
    break;
  case "board":
    cmdBoard(c, args);
    break;
  default:
    console.error(\`未知命令：\${cmd}（krystal help 查看用法）\`);
    process.exit(2);
}
`;

/** 短身份（每次进群注入，一两句话，省 token）
 *  关键：必须写明「这是背景，不是任务」——否则 agent 会把目标当成工单立刻开工 */
export function identityText(config: TeamConfig, memberId: string): string {
  const me = config.members.find((m) => m.id === memberId)!;
  const others = config.members.filter((m) => m.id !== memberId).map((m) => m.name);
  const who = `[身份·背景信息，不是任务] 你是团队「${config.name}」的成员「${me.name}」`;
  const job = me.role ? `。你的职责：${me.role}` : "";
  const goal = config.goal ? `。团队目标（背景，等派工后才执行）：${config.goal}` : "";
  const mate = others.length ? `。队友：${others.join("、")}` : "";
  const tools = `。协作：krystal roster / krystal send <队友> <消息> / krystal board`;
  const idle = "。收到后只回复一句「已就绪」即可：不要开始任何工作（不改文件、不做探查、不跑命令）；未派工 = 零动作，等人类在 Krystal 里派工。";
  return who + job + goal + mate + tools + idle;
}

/** 职责后续修改时的精简更新（避免同一身份在成员上下文里重复出现两份） */
export function identityUpdateText(config: TeamConfig, memberId: string): string {
  const me = config.members.find((m) => m.id === memberId)!;
  return `[身份更新·背景信息] 你的职责改为：${me.role ?? "（无）"}。以此为准，之前那条身份里的职责作废；队友与协作方式不变。仍未派工，请不要开始工作。`;
}

export function briefText(config: TeamConfig, memberId: string): string {
  const me = config.members.find((m) => m.id === memberId)!;
  const others = config.members.filter((m) => m.id !== memberId).map((m) => `${m.name}(${m.type})`);
  const home = sessionDir(config.id);
  // 注意：必须单行——send-keys 的换行会被 TUI 当作回车逐行提交
  return [
    `[Krystal 团队简报] 你是团队「${config.name}」的成员「${me.name}」${me.role ? `，职责：${me.role}` : ""}。` +
      `${config.goal ? `团队目标：${config.goal}。` : ""}队友：${others.join("、") || "（无）"}。`,
    `协作命令（在你的终端里执行）：krystal whoami 确认身份 · krystal roster 看队友与状态 ·`,
    `krystal send <队友> <消息> 给队友发消息（对方会看到，前缀 [from ${me.name}]）· krystal board [内容] 团队白板。`,
    `若 PATH 里找不到，用绝对路径 ${home}/bin/krystal。收到 [from X] 开头的消息即来自队友 X，回复用 krystal send X <消息>。`,
    `纪律：对齐只做一轮（确认在线/分工即可），不要互相复述或反复确认协议；纯确认类消息不必回复；`,
    `结论写白板而不是互发；无实质新信息时保持安静，等人类派工。简报全文：${home}/BRIEF.md`,
  ].join(" ");
}

/** 生成会话工具包（bin/krystal）与团队简报（BRIEF.md）。幂等，可反复调用。 */
export function ensureKit(config: TeamConfig): void {
  const dir = sessionDir(config.id);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const helper = path.join(bin, "krystal");
  fs.writeFileSync(helper, HELPER);
  fs.chmodSync(helper, 0o755);
  const boardPath = path.join(dir, "board.md");
  if (!fs.existsSync(boardPath)) {
    const seed: string[] = [`# ${config.name} 团队白板`, ""];
    if (config.goal) seed.push(`**目标**：${config.goal}`, "");
    if (config.protocol?.length) {
      seed.push("**协作协议（预置）**", ...config.protocol.map((p, i) => `${i + 1}. ${p}`), "");
    }
    seed.push("---", "", "（成员请在此追加状态与结论：`krystal board <内容>`）", "");
    fs.writeFileSync(boardPath, seed.join("\n"));
  }
  const lines: string[] = [
    `# ${config.name} — 团队简报`,
    ``,
    `> 这是**背景信息，不是任务**。未派工 = 零动作（不改文件、不做探查）；等人类派工后按协议执行。`,
    ``,
    ...(config.goal ? [`**团队目标**：${config.goal}`, ``] : []),
    `本团队由 Krystal 编排，共 ${config.members.length} 名成员（含职责）：`,
    ...config.members.map((m) => `- **${m.name}**（${m.type}）${m.role ? `— ${m.role}` : m.command ? `— \`${m.command}\`` : ""}`),
    ``,
    ...(config.protocol && config.protocol.length
      ? ["## 协作协议（已预置，无需再互相谈判）", "", ...config.protocol.map((p, i) => `${i + 1}. ${p}`), ""]
      : []),
    `## 你与队友的协作方式`,
    ``,
    `在你的终端里执行（Krystal 已把 \`krystal\` 放进你们的 PATH；若被 profile 重置 PATH，用绝对路径 \`${bin}/krystal\`）：`,
    ``,
    "```",
    `krystal whoami            确认自己的身份`,
    `krystal roster            查看队友与在线状态`,
    `krystal send <队友> <消息>  给队友发消息（出现在对方会话，前缀 [from 你]）`,
    `krystal board [内容]       查看 / 追加团队白板（异步协作）`,
    "```",
    ``,
    `- 收到 \`[from X]\` 开头的消息 = 队友 X 发来的，回复用 \`krystal send X <消息>\``,
    `- 需要人工介入（改代码、审批、环境问题）时，直接在会话里说明即可，人类在 Krystal 里看着所有成员`,
    `- **对齐只做一轮**：确认身份/在线/分工即可，不要互相复述协议、不要逐条确认`,
    `- **纯确认类消息不必回复**（收到"收到/同意/确认"就停手，避免礼貌循环）`,
    `- **结论写白板**，不要把长内容在会话间来回搬运`,
    `- 频率保护：同一对队友 60 秒内互发超过 3 条（或全局 6 条）会被自动阻止`,
    `- 无实质新信息时保持安静，等人类派工`,
    `- **不要修改 Krystal 自身的源码/仓库**：对 Krystal 的改进请写白板或 send 给人类，由人类落地（避免与助手互相覆盖）`,
    ``,
    `工作目录：\`${config.cwd}\``,
    `引擎会话：\`${config.tmuxSession}\``,
  ];
  fs.writeFileSync(path.join(dir, "BRIEF.md"), lines.join("\n") + "\n");
}