// Krystal — 终端闸门（恒定完全访问；spec §12.4 #19/#20）
// 只拦两类：**不可逆**（删除类 / force push / 磁盘 / 系统级）与**隐私**（凭据文件 / 密钥导出）。
// 这三条安全网不是安全沙箱（真正的强制层 = OS 沙箱/工作副本，§2.1 第三层）；
//   ① 黑名单-不可逆；② 黑名单-隐私；③ 路径围栏 + 防误删（重定向不许截断已存在文件）
import fs from "node:fs";
import path from "node:path";

export type List = "black" | "fence";
export interface Decision {
  allow: boolean;
  list?: List;
  reason?: string;
}

/** 黑名单-不可逆：删了就回不来 / 磁盘级 / 系统级 */
const BLACK: { re: RegExp; why: string }[] = [
  { re: /(^|[\s;|&])(rm|rmdir|unlink|shred)(\s|$)/, why: "删除类命令（rm/rmdir/unlink/shred）" },
  { re: /git\s+clean/, why: "git clean（会删未跟踪文件）" },
  { re: /git\s+reset\s+--hard/, why: "git reset --hard（丢弃未提交改动）" },
  { re: /git\s+(checkout|restore)\s+(--\s+)?[^\s]*\s*(\.|--)/, why: "git checkout/restore 覆盖工作区" },
  { re: /git\s+branch\s+-D/, why: "git branch -D（强制删分支）" },
  // git push 本身放行（GitHub 能力）；只拦不可逆变体
  { re: /git\s+push[^;|&]*\s(-f|--force)(\s|$)/, why: "git push --force（覆写远端历史，不可逆；--force-with-lease 可用）" },
  { re: /git\s+push[^;|&]*\s--delete(\s|$)/, why: "git push --delete（删除远端分支，不可逆）" },
  { re: /git\s+push\s+\S+\s+:\S+/, why: "git push :refspec（删除远端分支，不可逆）" },
  { re: /(^|[\s;|&])(sudo|su|doas)(\s|$)/, why: "提权命令" },
  { re: /(^|[\s;|&])(dd|mkfs|mkfs\.\w+|fdisk|parted|diskutil|mount|umount|newfs)(\s|$)/, why: "磁盘级命令" },
  { re: /(^|[\s;|&])(shutdown|reboot|halt|killall|pkill|systemctl|launchctl|crontab)(\s|$)/, why: "系统/进程控制（kill <pid> 可用，pkill/killall 误伤面大）" },
  { re: /(curl|wget)[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)/, why: "从网络管道执行脚本" },
  { re: /:\s*\(\s*\)\s*\{/, why: "fork 炸弹模式" },
  { re: /(^|[\s;|&])history\s+-c/, why: "清空历史" },
  { re: /(^|[\s;|&])defaults\s+write/, why: "改系统偏好" },
  { re: />\s*\/dev\/(sd|disk|rdisk)/, why: "写裸设备" },
];

/** 黑名单-隐私：凭据与密钥不进模型上下文（模型输出会发到云端 provider） */
const PRIVACY: { re: RegExp; why: string }[] = [
  { re: /(^|[\s;|&'"=])(env|printenv)(\s|$)/, why: "导出全部环境变量（含密钥）" },
  { re: /\.ssh\b|\.aws\b|\.gnupg|\.netrc|\.git-credentials|\.kube\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b/, why: "凭据/私钥文件（隐私）" },
  { re: /(^|[\s;|&])(cat|head|tail|less|more|strings|xxd|base64)\s+[^;|&]*\.env\b/, why: "读取 .env（含密钥，隐私）" },
  { re: /gh\s+auth\s+token/, why: "打印 GitHub 凭据（隐私）" },
];

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

/**
 * 闸门决策：黑名单 → 路径围栏 → 防误删（重定向不许截断已存在文件）→ 放行。
 * @param exists 注入的路径存在性检查（便于测试与精确判断「是否误删」）
 */
export function decide(cmd: string, cwd: string, exists: (p: string) => boolean = (p) => fs.existsSync(p)): Decision {
  const c = cmd.trim();
  if (!c) return { allow: false, list: "fence", reason: "空命令" };

  // ① 黑名单：不可逆 + 隐私，一律拦
  for (const b of [...BLACK, ...PRIVACY]) if (b.re.test(c)) return { allow: false, list: "black", reason: `黑名单拦截：${b.why}` };

  // ② 路径围栏：不许碰工作目录之外
  const out = outsideCwd(c, cwd);
  if (out) return { allow: false, list: "fence", reason: `越出工作目录（${out}）` };

  // ③ 防误删：不许覆盖/截断已存在的数据
  for (const r of redirectTargets(c)) {
    if (!r.append) {
      const abs = path.resolve(cwd, r.path);
      if (exists(abs)) return { allow: false, list: "black", reason: `拒绝截断已存在文件（${r.path}）：用 >> 追加，或先确认` };
    }
  }
  return { allow: true, list: "fence" };
}
