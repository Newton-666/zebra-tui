// Krystal — 模型选择弹窗（overlay）：成员 → 来源 → 模型
import { SelectList, truncateToWidth, type Component } from "../../deps/pi-tui/dist/index.js";
import { bold, dim, fg } from "../ui/ansi.ts";
import { discoverModelGroups, type ModelGroup } from "../models.ts";
import type { Member } from "../types.ts";

const THEME = {
  selectedPrefix: (t: string) => fg("36", t),
  selectedText: (t: string) => bold(t),
  description: (t: string) => dim(t),
  scrollInfo: (t: string) => dim(t),
  noMatch: (t: string) => fg("33", t),
};

type Step = "member" | "source" | "model";

export class ModelPicker implements Component {
  /** 选定：成员 + 模型（空串表示「默认，不指定模型」） */
  onPick?: (member: Member, model: string) => void;
  onCancel?: () => void;

  private members: Member[];
  private member: Member | undefined;
  private groups: ModelGroup[] = [];
  private step: Step = "member";
  private list: SelectList | undefined;
  private title = "";
  private subtitle = "";

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

  private setList(items: { value: string; label: string; description?: string }[], onSelect: (v: string) => void, onBack: () => void): void {
    const list = new SelectList(items, Math.min(items.length, 14), THEME);
    list.onSelect = (item: { value: string }) => onSelect(item.value);
    list.onCancel = () => onBack();
    this.list = list;
  }

  private openMember(): void {
    this.step = "member";
    this.title = "选择成员";
    this.subtitle = "给哪个成员换模型";
    this.setList(
      [
        ...this.members.map((m) => ({
          value: m.id,
          label: m.name,
          description: `当前: ${m.model ?? "默认"} · ${m.type}`,
        })),
        { value: "__cancel", label: "取消" },
      ],
      (v) => {
        if (v === "__cancel") return this.onCancel?.();
        const m = this.members.find((x) => x.id === v);
        if (m) {
          this.member = m;
          this.openSource();
        }
      },
      () => this.onCancel?.(),
    );
  }

  private openSource(): void {
    const m = this.member!;
    this.step = "source";
    this.groups = discoverModelGroups(m.type);
    this.title = `选择模型来源 · ${m.name}`;
    this.subtitle = `当前: ${m.model ?? "默认"} · 来自 ${m.type} 的配置`;
    const items = [
      { value: "__none", label: "默认（不指定模型）", description: `跟随 ${m.type} 自身配置` },
      ...this.groups.map((g, i) => ({
        value: `g${i}`,
        label: g.group,
        description: g.note ?? (g.models.length ? `${g.models.length} 个 · 例: ${g.models[0]!.value}` : ""),
      })),
      { value: "__custom", label: "自定义…", description: "合上弹窗后用 :model <成员> <模型> 手输" },
      { value: "__back", label: "返回" },
    ];
    this.setList(
      items,
      (v) => {
        if (v === "__none") return this.onPick?.(m, "");
        if (v === "__custom") return this.onCancel?.();
        if (v === "__back") return this.openMember();
        const gi = Number(v.slice(1));
        this.openModels(this.groups[gi]!);
      },
      () => this.openMember(),
    );
  }

  private openModels(group: ModelGroup): void {
    const m = this.member!;
    this.step = "model";
    this.title = `选择模型 · ${m.name} · ${group.group}`;
    this.subtitle = group.note ?? `${group.models.length} 个可选`;
    this.setList(
      [
        ...group.models.map((x) => ({ value: x.value, label: x.label, description: x.hint ?? "" })),
        { value: "__back", label: "返回" },
      ],
      (v) => {
        if (v === "__back") return this.openSource();
        this.onPick?.(m, v);
      },
      () => this.openSource(),
    );
  }

  render(width: number): string[] {
    const inner = Math.max(20, width);
    const out: string[] = [];
    out.push(bold(truncateToWidth(` ${this.title}`, inner, "…")));
    out.push(dim(truncateToWidth(` ${this.subtitle}`, inner, "…")));
    out.push(...(this.list?.render(inner) ?? []));
    out.push(dim(" ↑↓ 选择 · enter 确认 · esc 返回/取消"));
    return out;
  }

  handleInput(data: string): void {
    try {
      this.list?.handleInput(data);
    } catch {
      /* 忽略单次输入错误 */
    }
  }

  invalidate(): void {
    this.list?.invalidate();
  }
}