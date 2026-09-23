// Krystal — 模型选择弹窗：自绘实心面板（成员 → 来源 → 模型），支持边打字边过滤
import { fuzzyFilter, matchesKey, Key, truncateToWidth, visibleWidth, type Component } from "../../deps/pi-tui/dist/index.js";
import { discoverModelGroups, type ModelGroup } from "../models.ts";
import type { Member } from "../types.ts";

type Step = "member" | "source" | "model";

interface Row {
  value: string;
  label: string;
  hint?: string;
}

// 原始 SGR（行内不出现中间 reset，面板底色才能铺满整行）
const sgr = (code: string) => `\x1b[${code}m`;
const RESET = "\x1b[0m";
const PANEL_BG = "48;5;236";
const ROW_BG = "48;5;238";
const BORDER = "38;5;45";
const DIM = "38;5;245";
const BRIGHT = "38;5;231";
const ACCENT = "38;5;51";

export class ModelPicker implements Component {
  /** 选定：成员 + 模型（空串 = 默认不指定） */
  onPick?: (member: Member, model: string) => void;
  onCancel?: () => void;

  private members: Member[];
  private member: Member | undefined;
  private groups: ModelGroup[] = [];
  private step: Step = "member";
  private rows: Row[] = [];
  private cursor = 0;
  private filter = "";
  private rawRows: Row[] = [];
  private title = "";
  private status = "";

  constructor(members: Member[], preselectMember?: string) {
    this.members = members;
    const pre = preselectMember ? members.find((m) => m.name === preselectMember || m.id === preselectMember) : undefined;
    if (pre) {
      this.member = pre;
      this.openSource();
    } else {
      this.openMember();
    }
  }

  // ---------------- 步骤与数据 ----------------
  private openMember(): void {
    this.step = "member";
    this.title = "选择成员";
    this.status = "给哪个成员换模型";
    this.setRows([
      ...this.members.map((m) => ({ value: m.id, label: m.name, hint: `${m.type} · ${m.model ?? "默认"}` })),
      { value: "__cancel", label: "取消", hint: "esc" },
    ]);
  }

  private openSource(): void {
    const m = this.member!;
    this.step = "source";
    this.groups = discoverModelGroups(m.type);
    this.title = `选择模型来源 · ${m.name}`;
    this.status = `当前 ${m.model ?? "默认"}`;
    this.setRows([
      { value: "__none", label: "默认（不指定模型）", hint: `跟随 ${m.type}` },
      ...this.groups.map((g, i) => ({ value: `g${i}`, label: g.group, hint: g.note ? "其他来源" : `${g.models.length}` })),
      { value: "__custom", label: "自定义…", hint: ":model 成员 模型" },
      { value: "__back", label: "返回", hint: "esc" },
    ]);
  }

  private openModels(group: ModelGroup): void {
    const m = this.member!;
    this.step = "model";
    this.title = `选择模型 · ${m.name} · ${group.group}`;
    this.status = group.note ?? "来自该 agent 的配置";
    this.setRows([
      ...group.models.map((x) => ({ value: x.value, label: x.value, hint: x.hint })),
      { value: "__back", label: "返回", hint: "esc" },
    ]);
  }

  private setRows(rows: Row[]): void {
    this.rawRows = rows;
    this.filter = "";
    this.applyFilter();
  }

  private applyFilter(): void {
    this.rows = this.filter ? fuzzyFilter(this.rawRows, this.filter, (r) => `${r.label} ${r.hint ?? ""}`) : this.rawRows;
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
  }

  private commit(row: Row): void {
    const m = this.member;
    switch (row.value) {
      case "__cancel":
        return this.onCancel?.();
      case "__back":
        if (this.step === "model") return this.openSource();
        if (this.step === "source" && this.members.length > 1 && !this.preselected) return this.openMember();
        return this.onCancel?.();
      case "__none":
        return m ? this.onPick?.(m, "") : undefined;
      case "__custom":
        return this.onCancel?.();
    }
    if (this.step === "member") {
      const found = this.members.find((x) => x.id === row.value);
      if (found) {
        this.member = found;
        this.preselected = true;
        return this.openSource();
      }
      return;
    }
    if (this.step === "source") {
      const gi = Number(row.value.slice(1));
      if (Number.isFinite(gi) && this.groups[gi]) return this.openModels(this.groups[gi]!);
      return;
    }
    if (m) this.onPick?.(m, row.value);
  }

  private preselected = false;

  // ---------------- 渲染 ----------------
  render(width: number): string[] {
    const w = Math.max(34, Math.min(width, 84));
    const inner = w - 6; // 两侧各留 3 列（│ + 2 空格）
    const body = Math.max(6, Math.min(14, this.rows.length));

    // 上边框（标题内嵌）
    const titleTxt = truncateToWidth(this.title, inner - 4, "…");
    const out: string[] = [];
    out.push(
      sgr(BORDER) + sgr(PANEL_BG) + "╭─ " + sgr(BRIGHT) + sgr("1") + titleTxt + RESET + sgr(PANEL_BG) +
        " " + "─".repeat(Math.max(1, w - 6 - visibleWidth(titleTxt))) + "╮",
    );
    // 状态行（当前模型 / 提示）
    const statusTxt = truncateToWidth(this.status, inner, "…");
    out.push(row(statusTxt, DIM, false, w));
    // 过滤行
    const fTxt = this.filter ? `过滤 ${this.filter}_` : "输入字母即可过滤";
    out.push(row(truncateToWidth(fTxt, inner, "…"), this.filter ? ACCENT : DIM, false, w));
    out.push(sgr(BORDER) + sgr(PANEL_BG) + "├" + "─".repeat(w - 2) + "┤" + RESET);

    // 列表（可见窗口随光标移动）
    const start = Math.max(0, Math.min(this.cursor - body + 1, this.rows.length - body));
    const page = this.rows.slice(start, start + body);
    page.forEach((r, i) => {
      const idx = start + i;
      const sel = idx === this.cursor;
      const label = (sel ? "▸ " : "  ") + r.label;
      const hint = r.hint ? `  ${r.hint}` : "";
      const lw = Math.min(visibleWidth(label) + 2, Math.floor(inner * 0.66));
      const shownLabel = truncateToWidth(label, lw, "…");
      const gap = " ".repeat(Math.max(1, inner - lw - visibleWidth(hint)));
      out.push(row(shownLabel + gap + hint, sel ? BRIGHT : "39", sel, w, sel));
    });
    for (let i = page.length; i < body; i++) out.push(row("", "39", false, w));

    // 下边框（按键提示 + 页码）
    const total = this.rows.length;
    const foot = `↑↓ 选择 · enter 确认 · esc 返回 · ${this.cursor + 1}/${total}`;
    out.push(
      sgr(BORDER) + sgr(PANEL_BG) + "╰─ " + RESET + sgr(PANEL_BG) + sgr(DIM) + truncateToWidth(foot, inner - 2, "…") +
        RESET + sgr(PANEL_BG) + " ".repeat(Math.max(1, w - 6 - visibleWidth(foot))) + sgr(BORDER) + "╯" + RESET,
    );
    return out;
  }

  handleInput(data: string): void {
    try {
      if (matchesKey(data, Key.up)) {
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.cursor = Math.min(Math.max(0, this.rows.length - 1), this.cursor + 1);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.cursor = Math.max(0, this.cursor - 8);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.cursor = Math.min(Math.max(0, this.rows.length - 1), this.cursor + 8);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const rowSel = this.rows[this.cursor];
        if (rowSel) this.commit(rowSel);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        if (this.filter) {
          this.filter = "";
          this.applyFilter();
          return;
        }
        if (this.step === "member") return this.onCancel?.();
        this.commit({ value: "__back", label: "" });
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
        return;
      }
      // 可打印字符 → 直接进入过滤（模型多时比翻页快得多）
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
        this.filter += data;
        this.applyFilter();
        this.cursor = 0;
      }
    } catch {
      /* 单次输入异常忽略 */
    }
  }

  invalidate(): void {}
}

/** 一行面板内容：整行同一底色，行尾统一 reset，保证不透出背后文字 */
function row(content: string, color: string, selected: boolean, w: number, highlight = false): string {
  const text = truncateToWidth(content, w - 6, "");
  const pad = " ".repeat(Math.max(0, w - 6 - visibleWidth(text)));
  const bgCode = highlight ? ROW_BG : PANEL_BG;
  return (
    sgr(BORDER) + sgr(PANEL_BG) + "│  " +
    sgr(bgCode) + sgr(color) + (selected ? sgr("1") : "") + text + pad +
    sgr(PANEL_BG) + "  " + sgr(BORDER) + "│" + RESET
  );
}