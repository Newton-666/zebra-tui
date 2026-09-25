// Krystal Bot — 回答段渲染回归测试（确定性，零 API、零 TTY）
// 用法：npm run test:render
//
// 覆盖（2026-09-25 修「新段覆盖旧段 + 重复打印 + final 覆盖上一段」）：
//   ① 段契约：createTextSegment 只认自己的 md/文本/定格标记
//   ② 一回合多段（思考/工具打断）：每段各自留存、各出现一次，不重复、不消失
//   ③ 先答后记：final 带文字时自成一段，前面的长答案原样保留
//   ④ 跨回合 + 定格：Transcript 缓存不会把旧块改成新内容
// 手法：真实 Transcript（import 自 bot-view）+ 真实 createTextSegment + 真实 Markdown；
//       只有「begin/close 的接线」是按 bot-view 的写法重搭的（14 行，见 makeScreen），
//       被测单元（段对象）与缓存层（Transcript）都是真的。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离 HOME / 会话目录：绝不碰真实记忆库与真实会话
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krystal-rendertest-"));
process.env.HOME = TMP;
process.env.KRISTAL_SESSIONS_DIR = path.join(TMP, "sessions");

const { Transcript, BOT_THEME, StreamText } = await import("../src/view/bot-view.ts");
const { createTextSegment } = await import("../src/view/stream-seg.ts");

const W = 100;
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const countOf = (lines: string[], needle: string) =>
  lines.filter((l) => l.includes(needle)).length;

// ── ① 段契约：谁的内容谁自己持有（此前共用一个 streamMd 槽位 → 全错）
{
  const a = createTextSegment(BOT_THEME);
  a.append("第一段的话");
  const b = createTextSegment(BOT_THEME);
  b.append("第二段的话");
  const ra = plain(a.comp.render(W)).join("\n");
  const rb = plain(b.comp.render(W)).join("\n");
  assert.ok(ra.includes("第一段的话"), "新段出现后，旧段必须还是自己的文字");
  assert.ok(!ra.includes("第二段的话"), "旧段不得改显新段的文字（重复打印的根源）");
  assert.ok(rb.includes("第二段的话"), "新段显示自己的文字");

  assert.equal(a.done, false, "流式中的段应是活块（逐帧重渲）");
  a.seal();
  assert.equal(a.done, true, "seal 后定格");
  assert.ok(plain(a.comp.render(W)).join("\n").includes("第一段的话"), "定格保留内容");

  const c = createTextSegment(BOT_THEME);
  assert.equal(c.isEmpty(), true, "空段应判 empty");
  c.append("流式半截");
  c.finish("权威全文");
  assert.equal(c.text, "权威全文", "final 的 e.text 是权威全文 → 校准");
  const d = createTextSegment(BOT_THEME);
  d.append("先答后记的答案");
  d.finish("");            // 空 final（先答后记）→ 绝不覆盖
  assert.equal(d.text, "先答后记的答案", "空 final 不清空已流式的内容");
  assert.equal(d.done, true, "空 final 也要定格");
  console.log("1) 段契约（互不干扰 / 定格 / 校准 / 空 final 不清空）✓");
}

// ── 装配层：按 bot-view.ts 的写法接线（真实 Transcript + 真实段对象）
function makeScreen() {
  const transcript = new Transcript();
  let liveThinking: InstanceType<typeof StreamText> | undefined;
  let liveText: ReturnType<typeof createTextSegment> | undefined;
  let kind: "thinking" | "text" | null = null;
  const push = (...its: (string | { render(w: number): string[] })[]) => transcript.items.push(...(its as never[]));
  const gap = () => {
    if (transcript.items.length > 0 && transcript.items[transcript.items.length - 1] !== "") push("");
  };
  const close = () => {
    liveText?.seal();
    liveThinking = undefined;
    liveText = undefined;
    kind = null;
  };
  const beginThinking = () => {
    if (kind) close();
    liveThinking = new StreamText("· thinking ", (t) => t);
    push(liveThinking);
    kind = "thinking";
  };
  const beginText = () => {
    if (kind) close();
    liveText = createTextSegment(BOT_THEME);
    push(liveText.comp);
    kind = "text";
  };
  const feed = (t: "thinking" | "text", delta: string) => {
    if (kind !== t) {
      gap();
      t === "thinking" ? beginThinking() : beginText();
    }
    if (t === "thinking") liveThinking?.append(delta);
    else liveText?.append(delta);
  };
  const tool = (name: string) => {
    close();
    gap();
    push(`  ╰─ ● ${name}`);
    close();
  };
  const final = (text: string) => {
    let seg = liveText;
    if (!seg && text.trim()) {
      gap();
      beginText();
      seg = liveText;
    }
    seg?.finish(text);
    close();
    push("");
  };
  return {
    feed, tool, final, close,
    screen: () => plain(transcript.render(W)),
    itemCount: () => transcript.items.length,
  };
}

// ── ② 一回合多段（思考/工具打断）+ 空 final：三段各自留存，各出现一次
{
  const s = makeScreen();
  s.feed("thinking", "先看 roster，确认 verifier 空闲…");
  s.feed("text", "序章·我先去看一下现状。");
  s.tool("run_command grep -n chat(");
  s.feed("thinking", "Interesting: grep found NOTHING…");
  s.feed("text", "中段·跑完 grep 的结论。");
  s.tool("read_file bot.ts");
  s.feed("thinking", "现在核对 read_file 的行号…");
  s.feed("text", "收尾·完整答复：结论 + 依据 + 下一步。");
  s.final(""); // 先答后记：收尾答复已流式给出，final 无文字
  const lines = s.screen();
  for (const marker of ["序章·我先去看一下现状。", "中段·跑完 grep 的结论。", "收尾·完整答复：结论 + 依据 + 下一步。"]) {
    assert.equal(countOf(lines, marker), 1, `「${marker}」应恰好出现一次（消失=被覆盖，>1=重复）`);
  }
  assert.ok(countOf(lines, "先看 roster") === 1 && countOf(lines, "跑完 grep 的结论") === 1, "思考块也各自留存");
  console.log("2) 一回合三段（思考/工具打断，空 final）→ 各自留存、无重复 ✓");
}

// ── ③ 先答后记 + final 带文字：长答案原样保留，final 自成一段
{
  const s = makeScreen();
  s.feed("text", "长答案：根因是共享槽位，修法是段即对象，共三处改动。");
  s.tool("memory remember");
  s.final("已记住这条结论。");
  const lines = s.screen();
  assert.equal(countOf(lines, "长答案：根因是共享槽位"), 1, "先答后记：长答案不得被 final 那句覆盖");
  assert.equal(countOf(lines, "已记住这条结论。"), 1, "final 的文字应自成一段");
  assert.equal(lines.filter((l) => l.includes("长答案")).length, 1, "长答案只出现一次");
  console.log("3) 先答后记（final 带文字）→ 长答案保留 + final 自成一段 ✓");
}

// ── ④ 跨回合：第二回合结束后，第一回合的块内容不变（Transcript 缓存/定格回归）
{
  const s = makeScreen();
  s.feed("text", "回合1 第1段：取证结论。");
  s.tool("run_command");
  s.feed("text", "回合1 第2段：候选根因。");
  s.final("");
  s.feed("text", "回合2：新的问题与答复。");
  s.final("回合2 的最终答复。");
  const lines = s.screen();
  assert.equal(countOf(lines, "回合1 第1段：取证结论。"), 1, "旧回合第 1 段不得被后续内容改写");
  assert.equal(countOf(lines, "回合1 第2段：候选根因。"), 1, "旧回合第 2 段不得被后续内容改写");
  assert.equal(countOf(lines, "回合2 的最终答复。"), 1, "新回合答复正常");
  console.log("4) 跨回合：旧块内容不被改写（缓存 + 定格）✓");
}

// ── ⑤ 接线护栏：bot-view 不得再引入「共享回答槽位」（回归的真正防线）
// 说明：段对象与缓存层都有真测试（①–④）；这一个盯的是**接线**——
// 当年 bug 就出在 bot-view 里 `let streamMd` 这种“多块共用一个可变变量”的写法上。
{
  // 只看代码，不看注释（教训注释里本来就会提到 streamMd，不能自我绊倒）
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const botView = stripComments(fs.readFileSync(new URL("../src/view/bot-view.ts", import.meta.url), "utf8"));
  const segMod = stripComments(fs.readFileSync(new URL("../src/view/stream-seg.ts", import.meta.url), "utf8"));
  assert.ok(!/\bstreamMd\b/.test(botView), "bot-view 不得再出现共享槽位 streamMd（教训见 stream-seg.ts 注释）");
  assert.ok(!/let\s+liveText:\s*\{[^}]*md:\s*Markdown/.test(botView), "回答段必须由 createTextSegment 造，不得内联成共享闭包");  assert.ok(botView.includes("createTextSegment(BOT_THEME)"), "回答段应由 createTextSegment 创建");
  assert.ok(/seg\?\.finish\(e\.text\)/.test(botView), "final 只能校准本段（seg.finish），不得写别的槽位");
  assert.ok(/md\.render\(w\)/.test(segMod), "段的 render 必须永久绑自己的 md");
  console.log("5) 接线护栏（bot-view 无共享槽位 · 段由 createTextSegment 创建）✓");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nKrystal Bot 渲染回归：全部通过 · 5 组");