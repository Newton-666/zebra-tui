// Krystal — 终端闸门（三层策略）
// 设计：docs/agent-spec.md §2.1（三层强制）＋ owner 的 /mode 需求：
//   readonly：只有白名单通过（默认）
//   full    ：白名单全通过 · 灰名单在「不误删」前提下放行 · 黑名单自动拦截
// 注意（诚实说明）：full 模式下终端 = 任意代码执行能力，黑名单是**防误操作的安全网**，
//   不是安全沙箱。真正的强制层是 OS 沙箱 / 工作副本（§2.1 第三层，尚未实现）。
import fs from "node:fs";
import path from "node:path";

export type Mode = "readonly" | "full";
export type List = "white" | "gray" | "black" | "fence";
export interface Decision {
  allow: boolean;
  list?: List;
  reason?: string;
}

/** 白名单：任何模式都通过（只读 + 无副作用） */
const WHITE_FIRST = new Set([
  "pwd", "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "which", "stat", "file",
  "basename", "dirname", "realpath", "du", "df", "tree", "jq", "sort", "uniq", "cut", "tr", "diff",
  "echo", "printf", "date", "whoami", "uname", "node", "python3", "npm", "git",
]);
const GIT_WHITE = new Set(["status", "log", "diff", "show", "branch", "ls-files", "remote", "describe", "rev-parse"]);
/** 灰名单：full 模式放行（写/建/改，但不删除）；readonly 拦截 */
const GRAY_FIRST = new Set(["mkdir", "touch", "cp", "mv", "tee", "ln", "sed", "awk", "chmod", "npm", "npx", "pnpm", "yarn", "make", "pytest", "cargo", "go", "tsc", "eslint", "prettier", "python3", "node"]);
const GIT_GRAY = new Set(["add", "commit", "stash", "switch", "checkout", "restore", "init", "tag", "merge", "rebase", "revert", "cherry-pick"]);

/** 黑名单：**两种模式都拦**（不可逆 / 越权 / 系统级） */
const BLACK: { re: RegExp; why: string }[] = [
  { re: /(^|[\s;|&])(rm|rmdir|unlink|shred)(\s|$)/, why: "删除类命令（rm/rmdir/unlink/shred）" },
  { re: /git\s+clean/, why: "git clean（会删未跟踪文件）" },
  { re: /git\s+reset\s+--hard/, why: "git reset --hard（丢弃未提交改动）" },
  { re: /git\s+(checkout|restore)\s+(--\s+)?[^\s]*\s*(\.|--)/, why: "git checkout/restore 覆盖工作区" },
  { re: /git\s+branch\s+-D/, why: "git branch -D（强制删分支）" },
  { re: /git\s+push(\s|$)/, why: "git push（推送远端；请走 PR 流程）" },
  { re: /(^|[\s;|&])(sudo|su|doas)(\s|$)/, why: "提权命令" },
  { re: /(^|[\s;|&])(dd|mkfs|mkfs\.\w+|fdisk|parted|diskutil|mount|umount|newfs)(\s|$)/, why: "磁盘级命令" },
  { re: /(^|[\s;|&])(shutdown|reboot|halt|kill|killall|pkill|systemctl|launchctl|crontab|at)(\s|$)/, why: "系统/进程控制" },
  { re: /(curl|wget)[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)/, why: "从网络管道执行脚本" },
  { re: /:\s*\(\s*\)\s*\{/, why: "fork 炸弹模式" },
  { re: /(^|[\s;|&])history\s+-c/, why: "清空历史" },
  { re: /(^|[\s;|&])defaults\s+write/, why: "改系统偏好" },
  { re: />\s*\/dev\/(sd|disk|rdisk)/, why: "写裸设备" },
];

const shellMeta = (cmd: string) => /[;&|`$><]/.test(cmd);
const first = (cmd: string) => cmd.trim().split(/\s+/)[0] ?? "";
const gitSub = (cmd: string) => (first(cmd) === "git" ? cmd.trim().split(/\s+/)[1] ?? "" : "");

/** 重定向目标（`> file` / `>> file`）；用于「不许截断已存在文件」的判定 */
export function redirectTargets(cmd: string): { path: string; append: boolean }[] {
  const out: { path: string; append: boolean }[] = [];
  for (const m of cmd.matchAll(/(>>?)\s*([^\s;|&>]+)/g)) out.push({ path: m[2]!, append: m[1] === ">>" });
  return out;
}

/** 路径围栏：命令里出现的绝对路径/上跳路径必须在 cwd 之内 */
export function outsideCwd(cmd: string, cwd: string): string | undefined {
  const tokens = cmd.split(/\s+/).filter((t) => t && !t.startsWith("-"));
  for (const t of tokens) {
    const p = t.replace(/^[>]{1,2}/, "").replace(/[;|&]+$/, "");
    if (!p.startsWith("/") && !p.startsWith("~") && !p.startsWith("..")) continue;
    if (p.startsWith("~")) return p;
    const abs = path.resolve(cwd, p);
    if (!(abs === cwd || abs.startsWith(cwd + path.sep))) return p;
  }
  return undefined;
}

const needsWrite = (cmd: string) => {
  const f = first(cmd);
  if (GRAY_FIRST.has(f)) return true;
  if (f === "git" && GIT_GRAY.has(gitSub(cmd))) return true;
  if (redirectTargets(cmd).length) return true;
  return false;
};

/**
 * 闸门决策。返回值带 list（白/灰/黑/围栏），界面据此显示被哪一层拦下。
 * @param exists 注入的路径存在性检查（便于测试与精确判断「是否误删」）
 */
export function decide(cmd: string, mode: Mode, cwd: string, exists: (p: string) => boolean = (p) => fs.existsSync(p)): Decision {
  const c = cmd.trim();
  if (!c) return { allow: false, list: "fence", reason: "空命令" };

  // ① 黑名单：任何模式都拦
  for (const b of BLACK) if (b.re.test(c)) return { allow: false, list: "black", reason: `黑名单拦截：${b.why}` };

  // ② 路径围栏：不许碰工作目录之外
  const out = outsideCwd(c, cwd);
  if (out) return { allow: false, list: "fence", reason: `越出工作目录（${out}）` };

  // ③ 白名单（只读）
  if (!needsWrite(c)) {
    const f = first(c);
    const ok = f === "git" ? GIT_WHITE.has(gitSub(c)) || gitSub(c) === "" : WHITE_FIRST.has(f);
    if (ok) {
      // 白名单里的组合命令（如 `grep x | head`）在 full 下放行，只读模式下仍拦（避免误用重定向/管道改文件）
      if (shellMeta(c) && mode === "readonly") return { allow: false, list: "gray", reason: "只读模式：不接受管道/重定向（/mode full 可放行）" };
      return { allow: true, list: "white" };
    }
  }

  // ④ 只读模式：灰名单一律拦
  if (mode === "readonly") return { allow: false, list: "gray", reason: "只读模式：写类命令需 /mode full" };

  // ⑤ full 模式：灰名单放行，但「不误删」——不许覆盖/截断已存在的数据
  for (const r of redirectTargets(c)) {
    if (!r.append) {
      const abs = path.resolve(cwd, r.path);
      if (exists(abs)) return { allow: false, list: "black", reason: `拒绝截断已存在文件（${r.path}）：用 >> 追加，或先确认` };
    }
  }
  if (needsWrite(c)) return { allow: true, list: "gray" };
  return { allow: false, list: "black", reason: `不在白/灰名单内：${first(c)}` };
}

export const modeLabel = (m: Mode) => (m === "full" ? "完全访问" : "只读");
/** 兼容旧调用（只读模式判定） */
export const commandAllowed = (cmd: string): boolean => decide(cmd, "readonly", process.cwd()).allow;
