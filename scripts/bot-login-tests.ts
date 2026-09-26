// Krystal Bot — /login 与模型端点回归测试（确定性：假本地服务，零真实 API）
// 用法：npm run test:login
//
// 覆盖（owner 报的三个问题）：
//   ① 「输入 API key 总是不行」：预填旧 key 会被新 key 拼在前面 → 政策集中到 nextApiKey + 不预填密钥
//   ② 「本地模型没有 API」：本机服务不问 key（占位 none，pi 同款做法），且整条链路能真的跑通
//   ③ 「/model 列的是哪家的模型」：列表头写明端点，一屏只列当前 provider
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// 隔离 HOME：绝不碰真实 ~/.krystal 配置
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krystal-logintest-"));
process.env.HOME = TMP;
process.env.KRISTAL_SESSIONS_DIR = path.join(TMP, "sessions");

const B = await import("../src/builder.ts");
const { fetchModelInfos, nextApiKey, maskKey, PROVIDER_PRESETS, testBuilder } = B;
const { Input } = await import("../deps/pi-tui/dist/index.js");
const { endpointLabel } = await import("../src/view/bot-view.ts");

// ── ① 密钥政策：留空保持 / 新值覆盖 / 无值占位
{
  assert.equal(nextApiKey("", "sk-old"), "sk-old", "留空回车 → 保持已存 key");
  assert.equal(nextApiKey("  sk-new  ", "sk-old"), "sk-new", "输入了新值 → 用新值（两端空白删掉）");
  assert.equal(nextApiKey("", undefined), "none", "从无 key（本地服务）→ 占位 none");
  assert.equal(nextApiKey("   ", "sk-old"), "sk-old", "纯空白视为留空");

  // 复现根因：预填 + 敲键 = 新 key 拼在旧 key 前面（这就是「输入 API 总是不行」）
  const i = new Input();
  i.setValue("sk-OLDKEY123456");
  for (const ch of "sk-NEWKEY") i.handleInput(ch);
  assert.equal(i.getValue(), "sk-NEWKEYsk-OLDKEY123456", "预填的 Input 光标停在位置 0（pi-tui 行为）");
  assert.notEqual(i.getValue(), "sk-NEWKEY", "→ 所以密钥格**绝不能**预填已存 key");
  console.log("1) 密钥政策（留空保持 · 新值覆盖 · 本地占位 · 不预填密钥）✓");
}

// ── ② 本机服务：预设标记 + 不用真 key 就能拉列表/测连接
{
  const locals = PROVIDER_PRESETS.filter((p) => p.local).map((p) => p.id);
  assert.deepEqual(locals.sort(), ["lmstudio", "ollama"], "本机预设要标 local（/login 跳密钥步）");
  assert.ok(
    PROVIDER_PRESETS.filter((p) => p.local).every((p) => /localhost|127\.0\.0\.1/.test(p.baseUrl)),
    "本机预设的 baseUrl 必须指向本机",
  );

  // 假 Ollama：/v1/models + /v1/chat/completions（都不校验 key）
  const seen: { url: string; auth?: string }[] = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const body = (obj: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url?.endsWith("/models")) return body({ data: [{ id: "llama3.1:8b", context_length: 131072 }, { id: "qwen2.5-coder:7b" }] });
    if (req.url?.endsWith("/chat/completions")) return body({ choices: [{ message: { content: "ok" } }] });
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const localCfg = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: nextApiKey("", undefined), model: "" };

  const infos = await fetchModelInfos(localCfg);
  assert.deepEqual(infos.map((m) => m.id), ["llama3.1:8b", "qwen2.5-coder:7b"], "无真 key 也能拉到本机模型列表");
  assert.equal(infos.find((m) => m.id === "llama3.1:8b")!.contextTokens, 131072, "本机上报的窗口也要学进来");
  const { getWindow } = await import("../src/windows.ts");
  assert.equal(getWindow("llama3.1:8b"), 131072, "上报的窗口要落进 windows.json（阈值/百分比全链路生效）");

  // 连接测试（lenient：思考型模型 content 为空也算过）
  await testBuilder({ ...localCfg, model: "llama3.1:8b" });
  assert.ok(seen.some((s) => s.auth === "Bearer none"), "本地也要带占位 key（pi 同款），服务端忽略它");
  assert.ok(seen.some((s) => s.url === "/v1/models"), "拉取的路径正确（baseUrl 已含 /v1）");
  srv.close();
  console.log("2) 本机服务（local 标记 · 占位 key · 真跑通 /models 与 /chat/completions）✓");
}

// ── ③ 列表头写明端点来源（「只有 glm 还是全部」不再靠猜）
{
  assert.equal(endpointLabel("https://open.bigmodel.cn/api/paas/v4"), "open.bigmodel.cn", "云端点 → 域名");
  assert.equal(endpointLabel("http://localhost:11434/v1"), "localhost:11434", "本机端点 → 带端口");
  assert.equal(endpointLabel("不是 URL"), "不是 URL", "坏 URL 不崩（降级原文）");
  console.log("3) 端点标签（列表头写明这一屏是哪家的模型）✓");
}

// ── ④ 结构护栏：密钥格不得预填、必须允许空提交、本机预设必须跳过密钥步
{
  const src = fs
    .readFileSync(new URL("../src/view/bot-view.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const cut = src.indexOf("const showKey = (): void =>");
  assert.ok(cut > 0, "找不到 showKey —— 接线改名了，护栏要跟着更新");
  const keyStep = src.slice(cut, cut + 900); // 只盯这一段（密钥步）
  assert.ok(keyStep.includes('"",'), "密钥格必须传空 prefill（否则新 key 会被拼在旧 key 前面）");
  assert.ok(!keyStep.includes("draft.apiKey ?? \"\""), "密钥格不得回退到 prefill 已存 key");
  assert.ok(keyStep.includes("allowEmpty: true"), "密钥格必须允许空提交（留空保持 / 本机占位）");
  assert.ok(/preset\.local[\s\S]{0,220}startFetch\(\)/.test(src), "本机预设必须跳过密钥步直接拉列表");
  assert.ok(!/openInputOverlay\(\s*`API Key[^`]*`,\s*draft\.apiKey/.test(src), "任何地方都不得预填密钥");
  console.log("4) 结构护栏（不预填密钥 · 允许空提交 · 本机跳密钥步）✓");
}

// ── ⑤ 配置落盘：凭据共用、Bot 模型分离（/login 保存后 /model 换模型不互相踩）
{
  const cfg = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-x", model: "m-platform" };
  B.saveBuilder(cfg);
  assert.deepEqual(B.loadBuilder(), cfg, "saveBuilder/loadBuilder 往返一致");
  assert.equal(B.loadBotModel(), undefined, "未设过 bot 模型 → 回落平台模型");
  B.setBotModel("m-bot");
  assert.equal(B.loadBotModel(), "m-bot", "setBotModel 写入 bot.model");
  assert.equal(B.loadBuilder()!.model, "m-platform", "setBotModel **不得**动平台模型（模型分离）");
  assert.ok(maskKey("sk-1234567890abcdef").includes("…"), "密钥显示要打码");
  const mode = fs.statSync(B.builderConfigPath()).mode & 0o777;
  assert.equal(mode, 0o600, "凭据文件权限必须是 0600");
  console.log("5) 配置落盘（凭据共用 · Bot 模型分离 · 打码 · 0600）✓");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nKrystal Bot 登录/端点回归：全部通过 · 5 组");