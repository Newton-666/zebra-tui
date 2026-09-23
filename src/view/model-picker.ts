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

// 原始 SGR：整行只在末尾 reset，行内不用会打断底色的 reset
const sgr = (code: string) => `\x1b[${code}m`;
const RESET = "\x1b[0m";
const PANEL_BG = "48;5;236";
const ROW_SEL_BG = "48;5;238";
const BORDER = "38;5;45";
const DIM = "38;5;245";
const BRIGHT = "38;5;231";
const ACCENT = "38;5;51";
const NORMAL = "39";

export class ModelPicker implements Component {
  /** 选定：成员 + 模型（空串 = 默认不指定） */
  onPick?: (member: Member, model: string) => void;
  onCancel?: () => void;

  private members: Member[];
  private member: Member | undefined;
  private groups: ModelGroup[] = [];
  private step: Step = "member";
  private rawRows: Row[] = [];
  private rows: Row[] = [];
  private cursor = 0;
  private filter = "";
  private title = "";
  private status = "";
  private pickedMember = false;

  constructor(members: Member[], preselectMember?: string) {
    this.members = members;
    const pre = preselectMember ? members.find((m) => m.name === preselectMember || m.id === preselectMember) : undefined;
    if (pre) {
      this.member = pre;
      this.pickedMember = true;
      this.openSource();
    } else {
      this.openMember();
    }
  }

  // ---------------- 数据 ----------------
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
      ...this.groups.map((g, i) => ({ value: `g${i}`, label: g.group, hint: g.note ? "需已配置" : `${g.models.length} 个` })),
      { value: "__custom", label: "自定义…", hint: "用 :model 成员 模型" },
      { value: "__back", label: "返回", hint: "esc" },
    ]);
  }

  private openModels(group: ModelGroup): void {
    const m = this.member!;
    this.step = "model";
    this.title = `选择模型 · ${m.name} · ${group.group}`;
    this.status = group.note ?? `${group.models.length} 个可选 · 输入字母过滤`;
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
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, this.rows.length - 1)));
  }

  private commit(row: Row): void {
    switch (row.value) {
      case "__cancel":
        return this.onCancel?.();
      case "__back":
        if (this.step === "model") return this.openSource();
        if (this.step === "source" && !this.pickedMember) return this.openMember();
        return this.onCancel?.();
      case "__none":
        return this.member ? this.onPick?.(this.member, "") : undefined;
      case "__custom":
        return this.onCancel?.();
    }
    if (this.step === "member") {
      const found = this.members.find((x) => x.id === row.value);
      if (found) {
        this.member = found;
        this.pickedMember = true;
        this.openSource();
      }
      return;
    }
    if (this.step === "source") {
      const gi = Number(row.value.slice(1));
      if (Number.isFinite(gi) && this.groups[gi]) this.openModels(this.groups[gi]!);
      return;
    }
    if (this.member) this.onPick?.(this.member, row.value);
  }

  // ---------------- 渲染 ----------------
  render(width: number): string[] {
    const w = Math.max(40, Math.min(width, 84));
    const inner = w - 6; // │ + 2 空格 … 2 空格 + │
    const bodyRows = Math.max(6, Math.min(14, Math.max(this.rows.length, 6)));
    const out: string[] = [];

    // 上边框（宽度按实际测量补齐，CJK 也不会错位）
    const titleTxt = truncateToWidth(this.title, Math.max(4, inner - 4), "…");
    const topPrefix = "╭─ " + titleTxt + " ";
    out.push(
      sgr(BORDER) + sgr(PANEL_BG) + "╭─ " + sgr(BRIGHT) + sgr("1") + titleTxt + RESET + sgr(PANEL_BG) + " " +
        "─".repeat(Math.max(1, w - visibleWidth(topPrefix) - 1)) + sgr(BORDER) + "╮" + RESET,
    );
    // 状态 + 过滤
    out.push(panelRow(truncateToWidth(this.status, inner, "…"), DIM, false, w));
    const fTxt = this.filter ? `过滤 ${this.filter}▌` : "输入字母过滤 · ↑↓ 选择";
    out.push(panelRow(truncateToWidth(fTxt, inner, "…"), this.filter ? ACCENT : DIM, false, w));
    out.push(sgr(BORDER) + sgr(PANEL_BG) + "├" + "─".repeat(w - 2) + "┤" + RESET);

    // 列表
    const total = this.rows.length;
    if (total === 0) {
      out.push(panelRow("  （无匹配，按 ⌫ 或 esc 清除过滤）", DIM, false, w));
      for (let i = 1; i < bodyRows; i++) out.push(panelRow("", NORMAL, false, w));
    } else {
      const start = Math.max(0, Math.min(this.cursor - bodyRows + 1, total - bodyRows));
      const page = this.rows.slice(start, start + bodyRows);
      page.forEach((r, i) => {
        const idx = start + i;
        const sel = idx === this.cursor;
        const label = (sel ? "▸ " : "  ") + r.label;
        const hint = r.hint ? r.hint : "";
        const lw = Math.max(8, Math.min(visibleWidth(label) + 1, inner - 8));
        const shownLabel = truncateToWidth(label, lw, "…");
        const gap = " ".repeat(Math.max(1, inner - lw - visibleWidth(hint)));
        out.push(panelRow(shownLabel + gap + hint, sel ? BRIGHT : NORMAL, sel, w, sel));
      });
      for (let i = page.length; i < bodyRows; i++) out.push(panelRow("", NORMAL, false, w));
    }

    // 下边框
    const foot = total > 0 ? `enter 确认 · esc 返回 · ${this.cursor + 1}/${total}` : "esc 返回";
    const footTxt = truncateToWidth(foot, Math.max(4, inner - 4), "…");
    const botPrefix = "╰─ " + footTxt + " ";
    out.push(
      sgr(BORDER) + sgr(PANEL_BG) + "╰─ " + sgr(DIM) + footTxt + RESET + sgr(PANEL_BG) + " " +
        "─".repeat(Math.max(1, w - visibleWidth(botPrefix) - 1)) + sgr(BORDER) + "╯" + RESET,
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
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        const row = this.rows[this.cursor];
        if (row) this.commit(row);
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
        if (!this.filter) return;
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
        return;
      }
      // 可打印字符 → 直接过滤
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

/** 面板内容行：整行同一底色、行尾统一 reset（背后文字不会透出来） */
function panelRow(content: string, color: string, selected: boolean, w: number, highlight = false): string {
  const text = truncateToWidth(content, w - 6, "");
  const pad = " ".repeat(Math.max(0, w - 6 - visibleWidth(text)));
  const bgCode = highlight ? ROW_SEL_BG : PANEL_BG;
  return (
    sgr(BORDER) + sgr(PANEL_BG) + "│" + sgr(bgCode) + "  " +
    sgr(color) + (selected ? sgr("1") : "") + text + pad + "  " +
    sgr(PANEL_BG) + sgr(BORDER) + "│" + RESET
  );
}