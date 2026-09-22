// zebra — main app: header / team grid / status / editor
import fs from "node:fs";
import path from "node:path";
import {
  Editor,
  matchesKey,
  ProcessTerminal,
  TuiAltScreen,
  VStack,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "../deps/pi-tui/dist/index.js";
import { ensureTeamSession, paneAlive, respawnPane, sendText, syncPaneWidths } from "./agents.ts";
import { appendEvent, saveTeamConfig, sessionDir } from "./team.ts";
import { briefText } from "./kit.ts";
import { ScreenPoller } from "./poll.ts";
import { AgentCell } from "./view/cell.ts";
import { TeamGrid } from "./view/grid.ts";
import { MentionProvider } from "./ui/mention.ts";
import { BLUE_LIGHT, bold, chip, dim, fg, memberFg } from "./ui/ansi.ts";
import { KRYSTAL_GRADIENT, LOGO_ROWS, LOGO_WIDTH } from "./ui/logo.ts";
import type { Member, TeamConfig } from "./types.ts";

const SELECT_LIST_THEME = {
  selectedPrefix: (t: string) => fg("36", t),
  selectedText: (t: string) => bold(t),
  description: (t: string) => dim(t),
  scrollInfo: (t: string) => dim(t),
  noMatch: (t: string) => fg("33", t),
};

const EDITOR_THEME: EditorTheme = {
  borderColor: (s: string) => fg(BLUE_LIGHT, s), // 输入框两条线：浅蓝
  selectList: SELECT_LIST_THEME,
};

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

export async function runTeamApp(config: TeamConfig, seedScreens: Map<string, string[]>): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 });

  // --- engine
  let paneIds = ensureTeamSession(config, true);
  const poller = new ScreenPoller(() => paneIds, config.members, config.id, (m, pane) => respawnPane(config, m, pane));

  // --- header: Krystal logo（共享 ANSI Shadow 模块）+ 全宽圆角框
  const logoRows = LOGO_ROWS;
  const LOGO_W = LOGO_WIDTH;

  class HeaderBar implements Component {
    invalidate(): void {}
    render(width: number): string[] {
      const inner = Math.max(10, width - 2);
      const side = width >= LOGO_W + 52;
      const info = [
        "",
        ` ${bold("Krystal")} ${dim("·")} ${bold(config.name)} ${dim(`· ${config.members.length} members`)}`,
        dim(` cwd: ${config.cwd}`),
        ...(config.goal ? [dim(` 目标: ${config.goal}`)] : [dim(" 输入广播全员 · 行首 @ 弹窗选人 · :brief 重发简报 · :quit 退出")]),
        "",
        "",
      ];
      const rows: string[] = [];
      for (let r = 0; r < logoRows.length; r++) {
        const logo = pad(fg(KRYSTAL_GRADIENT[r]!, logoRows[r]!), LOGO_W);
        const content = side ? ` ${logo}  ${info[r] ?? ""}` : ` ${logo}`;
        rows.push(dim("│") + pad(truncateToWidth(content, inner, "…"), inner) + dim("│"));
      }
      if (!side) {
        rows.push(dim("│") + pad(truncateToWidth(`  ${bold("Krystal")} ${dim("·")} ${config.name} ${dim(`· ${config.members.length} members · ${config.cwd}`)}`, inner, "…"), inner) + dim("│"));
      }
      return [dim("╭" + "─".repeat(Math.max(0, width - 2)) + "╮"), ...rows, dim("╰" + "─".repeat(Math.max(0, width - 2)) + "╯")];
    }
  }
  const header = new HeaderBar();

  // --- team grid (custom proportional columns + draggable divider)
  const cells = new Map<string, AgentCell>();
  for (const m of config.members) cells.set(m.id, new AgentCell(m));
  const teamGrid = new TeamGrid(config.members, cells, config.gridRatios, () => terminal.columns);
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  teamGrid.onRatioChanged = (ratios) => {
    config.gridRatios = [...ratios];
    saveTeamConfig(config);
    tui.requestRender();
    // 拖拽中 debounce 同步引擎窗格宽度（agent 按新宽度重排，排版不破坏）
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      try {
        const g = teamGrid.compute(terminal.columns);
        syncPaneWidths(config, paneIds, {
          colWidths: g.colWidths,
          width: g.totalWidth,
          height: Math.max(24, terminal.rows),
        });
      } catch {
        /* 同步尽力而为 */
      }
    }, 250);
  };

  // --- status line (inverse bar, width-aware)
  let lockedTo: string | undefined;
  let lastAction = "";
  class StatusBar implements Component {
    private parts = "";
    set(parts: string): void {
      this.parts = parts;
    }
    invalidate(): void {}
    render(width: number): string[] {
      // Starship 风格分段：蓝底品牌胶囊 + 成员状态 + 最近动作 + 提示（无整条反色底）
      const brand = chip(" Krystal ");
      const team = bold(config.name);
      const sep = " " + dim("·") + " ";
      const hints = dim(":to 锁定 · :quit 退出");
      const content = ` ${brand}  ${team}${sep}${this.parts}${sep}${hints} `;
      const vis = visibleWidth(content);
      if (vis >= width) return [truncateToWidth(content, width, "…")];
      return [content + " ".repeat(width - vis)];
    }
  }
  const status = new StatusBar();
  const renderStatus = () => {
    const parts = config.members
      .map((m) => {
        const f = poller.feeds.get(m.id)!;
        const active = Date.now() - f.changedAt < 4000 && f.alive;
        const dotCh = !f.alive ? dim("×") : active ? memberFg(m, "●") : dim("○");
        const locked = lockedTo === m.id ? memberFg(m, bold("◈")) : "";
        return `${dotCh} ${m.name}${locked}`;
      })
      .join(dim(" │ "));
    const action = lastAction ? dim(`${truncateToWidth(lastAction, 48, "…")}`) : "";
    status.set(action ? `${parts} ${dim("·")} ${action}` : parts);
    tui.requestRender();
  };

  // --- dispatch
  const dispatch = (targets: Member[], text: string) => {
    const sent: string[] = [];
    for (const t of targets) {
      const idx = config.members.indexOf(t);
      const paneId = paneIds[idx];
      if (!paneId) continue;
      try {
        sendText(paneId, text);
        sent.push(t.name);
      } catch {
        // pane 可能已死，跳过
      }
    }
    lastAction = `→ ${sent.join(",")}: ${text}`;
    appendEvent(config.id, { t: new Date().toISOString(), type: "dispatch", to: targets.map((t) => t.id), text });
    renderStatus();
  };

  const parseTargets = (text: string): Member[] | null => {
    // 行首 @tokens："@pi @codex msg" / "@all msg" / 普通消息
    let line = text;
    const ids: string[] = [];
    while (line.startsWith("@")) {
      const tok = line.split(/\s/, 1)[0]!;
      const rest = line.slice(tok.length).replace(/^\s+/, "");
      if (tok === "@all") return [...config.members];
      const hit = config.members.find((m) => `@${m.name}` === tok || `@${m.id}` === tok);
      if (!hit) break;
      ids.push(hit.id);
      line = rest;
    }
    if (ids.length === 0) return null;
    return config.members.filter((m) => ids.includes(m.id));
  };

  // --- editor (pi-style two-line input, wrapped in a rounded frame)
  const editor = new Editor(tui, EDITOR_THEME, { autocompleteMaxVisible: 6 });
  editor.setAutocompleteProvider(new MentionProvider(config.members));

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.addToHistory(trimmed);

    if (trimmed === ":quit" || trimmed === ":q") {
      void quit();
      return;
    }
    if (trimmed.startsWith(":to")) {
      const arg = trimmed.slice(3).trim();
      if (!arg || arg === "all") {
        lockedTo = undefined;
        lastAction = "目标: 全体";
      } else {
        const m = config.members.find((mm) => mm.name === arg || mm.id === arg);
        if (m) {
          lockedTo = m.id;
          lastAction = `目标锁定: ${m.name}`;
        } else {
          lastAction = `未知目标: ${arg}`;
        }
      }
      renderStatus();
      return;
    }
    if (trimmed === ":brief" || trimmed.startsWith(":brief ")) {
      const arg = trimmed.slice(6).trim();
      const targets = arg
        ? config.members.filter((mm) => mm.name === arg || mm.id === arg)
        : [...config.members];
      let n = 0;
      for (const m of targets) if (injectBrief(m)) n++;
      lastAction = `已向 ${n} 名成员重发团队简报`;
      saveTeamConfig(config);
      renderStatus();
      return;
    }
    if (trimmed === ":team") {
      paneIds = ensureTeamSession(config, true);
      lastAction = "tmux 会话已重建";
      renderStatus();
      return;
    }

    const explicit = parseTargets(trimmed);
    const targets = explicit ?? (lockedTo ? [config.members.find((m) => m.id === lockedTo)!].filter(Boolean) : [...config.members]);
    if (targets.length > 0) dispatch(targets, trimmed);
  };
  editor.onSubmit = (text: string) => {
    try {
      handleSubmit(text);
    } catch (e) {
      lastAction = `⚠ ${e instanceof Error ? e.message : String(e)}`;
      renderStatus();
    }
  };

  class EditorFrame implements Component, Focusable {
    private ed: Editor;
    constructor(ed: Editor) {
      this.ed = ed;
    }
    get focused(): boolean {
      return this.ed.focused;
    }
    set focused(v: boolean) {
      this.ed.focused = v;
    }
    handleInput(data: string): void {
      this.ed.handleInput(data);
    }
    invalidate(): void {
      this.ed.invalidate();
    }
    render(width: number): string[] {
      // 直接采用 pi-tui 的原生渲染（它自己用 EditorTheme.borderColor 画上下两条线，
      // 我方的边框重写会被渲染层的 SGR 规范化吃掉颜色）
      return this.ed.render(width);
    }
  }
  const editorFrame = new EditorFrame(editor);

  // --- poller → cells
  for (const m of config.members) {
    const seed = seedScreens.get(m.id);
    if (seed && seed.length > 0) {
      cells.get(m.id)!.setScreen(seed, true, false);
    }
  }
  poller.onChange = () => {
    for (const m of config.members) {
      const f = poller.feeds.get(m.id)!;
      const active = Date.now() - f.changedAt < 4000 && f.alive;
      cells.get(m.id)!.setScreen(f.lines, f.alive, active);
    }
    renderStatus();
  };
  poller.start();

  // --- 团队简报注入：成员启动就绪后告诉它「你是谁 / 队友是谁 / 怎么通信」
  const briefed = new Set<string>(config.briefed ?? []);
  const injectBrief = (m: Member): boolean => {
    const idx = config.members.indexOf(m);
    const paneId = paneIds[idx];
    if (!paneId || !paneAlive(paneId)) return false;
    try {
      sendText(paneId, briefText(config, m.id));
    } catch {
      return false;
    }
    briefed.add(m.id);
    appendEvent(config.id, { t: new Date().toISOString(), type: "note", text: `已向 ${m.name} 注入团队简报` });
    return true;
  };
  let briefTicks = 0;
  const briefTimer = setInterval(() => {
    briefTicks++;
    for (const m of config.members) {
      if (briefed.has(m.id)) continue;
      const f = poller.feeds.get(m.id)!;
      const ready = f.alive && f.lines.filter((l) => l.trim().length > 0).length >= 3;
      if (ready) injectBrief(m);
    }
    if (briefed.size >= config.members.length || briefTicks > 15) {
      clearInterval(briefTimer);
      config.briefed = [...briefed];
      saveTeamConfig(config);
      renderStatus();
    }
  }, 2000);
  briefTimer.unref?.();

  // --- 成员互相通信的中继显示（由会话内 `zebra send` 写入 last-relay）
  let lastRelayText = "";
  const relayTimer = setInterval(() => {
    try {
      const t = fs.readFileSync(path.join(sessionDir(config.id), "last-relay"), "utf8").trim();
      if (t && t !== lastRelayText) {
        lastRelayText = t;
        lastAction = truncateToWidth(t, 60, "…");
        renderStatus();
      }
    } catch {
      /* 还没有中继发生 */
    }
  }, 1500);
  relayTimer.unref?.();

  // 启动后同步一次引擎窗格宽度（首次渲染完成后 geometry 才可用）
  const startupSync = setTimeout(() => {
    try {
      const g = teamGrid.compute(terminal.columns);
      if (g.totalWidth > 0) {
        syncPaneWidths(config, paneIds, {
          colWidths: g.colWidths,
          width: g.totalWidth,
          height: Math.max(24, terminal.rows),
        });
      }
    } catch {
      /* 尽力而为 */
    }
  }, 800);
  startupSync.unref?.();

  // --- assemble
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto" },
      { component: teamGrid, basis: 0, grow: 1, minSize: 1 },
      { component: status, basis: "auto" },
      { component: editorFrame, basis: "auto" },
    ]),
  );
  tui.setFocus(editorFrame);

  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    poller.stop();
    tui.stop();
  };
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      void quit();
      return { consume: true };
    }
    return undefined;
  });

  // --- 分隔线拖拽（SGR 鼠标）：TuiAltScreen 的内部监听器会抢先消费鼠标事件，
  // 所以必须把拖拽监听器插到 inputListeners 队首才能看到 SGR 序列。
  let dragging = -1;
  /** 清掉 alt-screen 可能残留的文本选区状态（拖拽分隔线后防高亮残留） */
  const clearAltScreenSelection = () => {
    const t = tui as unknown as {
      selectionPressActive?: boolean;
      selectionAnchor?: unknown;
      selectionFocus?: unknown;
      selectionInitialRange?: unknown;
      lastClick?: unknown;
    };
    t.selectionPressActive = false;
    t.selectionAnchor = undefined;
    t.selectionFocus = undefined;
    t.selectionInitialRange = undefined;
    t.lastClick = undefined;
    tui.requestRender();
  };
  const SGR = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
  const mouseHandler = (data: string): { consume?: boolean } | undefined => {
    const m = SGR.exec(data);
    if (!m) return undefined;
    const button = Number(m[1]);
    const x = Number(m[2]) - 1;
    const isRelease = m[4] === "m";
    const isMotion = (button & 32) !== 0;
    const isLeft = (button & 3) === 0;
    if (dragging >= 0) {
      if (isRelease) {
        dragging = -1;
        clearAltScreenSelection();
      } else {
        teamGrid.dragTo(dragging, x);
      }
      return { consume: true };
    }
    if (!isRelease && !isMotion && isLeft) {
      const hit = teamGrid.hitDivider(x);
      if (hit >= 0) {
        dragging = hit;
        return { consume: true };
      }
    }
    return undefined;
  };
  {
    const set = (tui as unknown as { inputListeners: Set<unknown> }).inputListeners;
    const existing = [...set];
    set.clear();
    set.add(mouseHandler);
    for (const l of existing) set.add(l);
  }

  renderStatus();
  await new Promise<void>((resolve) => {
    const origStop = tui.stop.bind(tui);
    tui.stop = ((...a: Parameters<typeof origStop>) => {
      const r = origStop(...a);
      resolve();
      return r;
    }) as typeof tui.stop;
    tui.start();
  });
  // keep tmux session alive for later `zebra -c`
}
