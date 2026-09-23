// 诊断：找出 bot-view.ts 的括号/模板不平衡位置
import fs from "node:fs";
const src = fs.readFileSync("src/view/bot-view.ts", "utf8");
const st: [string, number][] = [];
let i = 0;
let ln = 1;
let mode: string | null = null;
while (i < src.length) {
  const ch = src[i]!;
  if (ch === "\n") { ln++; i++; continue; }
  if (mode === null) {
    if (src.startsWith("//", i)) { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (src.startsWith("/*", i)) { const j = src.indexOf("*/", i); i = j < 0 ? src.length : j + 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { mode = ch; i++; continue; }
    if (ch === "{" || ch === "(" || ch === "[") { st.push([ch, ln]); i++; continue; }
    if (ch === "}" || ch === ")" || ch === "]") {
      const top = st.pop();
      const want = ch === "}" ? "{" : ch === ")" ? "(" : "[";
      if (!top || top[0] !== want) { console.log(`✗ 第 ${ln} 行的 ${ch} 与栈顶 ${top?.[0]}（行 ${top?.[1]}）不配`); process.exit(0); }
      i++; continue;
    }
    i++; continue;
  }
  if (ch === "\\") { i += 2; continue; }
  if (mode === "`" && ch === "$" && src[i + 1] === "{") { st.push(["${", ln]); mode = "${"; i += 2; continue; }
  if (ch === mode) { mode = null; i++; continue; }
  i++;
}
if (st.length) console.log("未闭合:", JSON.stringify(st));
else console.log("扫描完成：括号全部配平 ✓");