#!/usr/bin/env node
// zebra — entry: zebra [-c] [-r <id>] [--dir <cwd>]
import fs from "node:fs";
import { loadSession, listSessions, lastScreens } from "./team.ts";
import { runWizardFlow } from "./view/wizard.ts";
import { runTeamApp } from "./app.ts";
import { tmuxAvailable } from "./agents.ts";

function parseArgs(argv: string[]) {
  const opts: { resume?: string; cont: boolean; dir?: string } = { cont: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-c" || a === "--continue") opts.cont = true;
    else if (a === "-r" || a === "--resume") opts.resume = argv[++i];
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("zebra — multi-agent team cockpit");
      console.log("  zebra            打开团队选择器/新建向导");
      console.log("  zebra -c         恢复最近一个团队");
      console.log("  zebra -r <id>    按会话 id 前缀恢复");
      console.log("  zebra --dir <p>  新团队的工作目录");
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  // 崩溃面：任何未捕获异常 → 落盘 + 退出，绝不假死
  const crashLog = (kind: string, e: unknown) => {
    const msg = `${new Date().toISOString()} [${kind}] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`;
    try { fs.appendFileSync("/tmp/zebra-crash.log", msg); } catch {}
  };
  process.on("uncaughtException", (e) => {
    crashLog("uncaught", e);
    console.error("zebra 崩溃（已写入 /tmp/zebra-crash.log）:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    crashLog("rejection", e);
  });

  const opts = parseArgs(process.argv.slice(2));
  if (!tmuxAvailable()) {
    console.error("zebra 需要 tmux（brew install tmux）");
    process.exit(1);
  }
  const sessions = listSessions();

  let result: Awaited<ReturnType<typeof runWizardFlow>>;
  if (opts.cont && sessions.length > 0) {
    result = { action: "resume", id: sessions[0]!.id };
  } else if (opts.resume) {
    const hit = sessions.find((s) => s.id.startsWith(opts.resume!));
    if (!hit) {
      console.error(`找不到会话: ${opts.resume}（可用: ${sessions.map((s) => s.id).join(", ")}）`);
      process.exit(1);
    }
    result = { action: "resume", id: hit.id };
  } else {
    // 交互模式：bot 原型退出后回到首页（其余动作交给下方流程）
    for (;;) {
      result = await runWizardFlow(opts.dir ?? process.cwd());
      if (result.action !== "bot") break;
      const { runBotFlow } = await import("./view/bot-view.ts");
      await runBotFlow(opts.dir ?? process.cwd());
    }
  }

  if (result.action === "quit") {
    console.log("zebra 再见 👋");
    return;
  }

  if (result.action === "resume") {
    const config = loadSession(result.id);
    console.error(`zebra · 恢复团队 ${config.name}（tmux 会话保留中，正在重接…）`);
    const seed = lastScreens(config.id);
    await runTeamApp(config, seed, false);
  } else {
    const config = result.config;
    const { createSession } = await import("./team.ts");
    const { createTeamSession } = await import("./agents.ts");
    createSession(config);
    createTeamSession(config);
    console.error(`zebra · 团队已创建: ${config.name} · 会话 ${config.id}`);
    await runTeamApp(config, new Map(), true);
  }

  console.log(`\nzebra 已退出。tmux 会话仍在后台运行：`);
  console.log(`  zebra -c            回到这个团队（视图与输出已存档）`);
  console.log(`  tmux attach -t zebra-<id>   直看原始窗格`);
}

main().catch((e) => {
  console.error("zebra:", e?.message ?? e);
  process.exit(1);
});
