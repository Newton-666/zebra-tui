// zebra — agent cell: rounded card frame + scrollable live tail (truncate, no wrap)
import { ScrollView, VStack, truncateToWidth, visibleWidth, type Component } from "../../deps/pi-tui/dist/index.js";
import { bold, dim, fg, memberFg } from "../ui/ansi.ts";
import type { Member } from "../types.ts";

const TAIL_KEEP = 400;

/** Fixed-width tail renderer: truncates each line to the cell width (no wrapping chaos). */
class Tail implements Component {
  private lines: string[] = [];
  private cached?: { w: number; out: string[] };

  set(lines: string[]): void {
    this.lines = lines;
    this.cached = undefined;
  }
  invalidate(): void {
    this.cached = undefined;
  }
  render(width: number): string[] {
    if (this.cached && this.cached.w === width) return this.cached.out;
    const out = this.lines.map((l) => truncateToWidth(l, width, ""));
    this.cached = { w: width, out };
    return out;
  }
}

/** Top border with embedded title: ╭─ ● pi (custom) ─────╮ */
class CellTop implements Component {
  private cached?: { w: number; line: string };
  private alive = true;
  private active = false;
  private member: Member;

  constructor(member: Member) {
    this.member = member;
  }

  set(alive: boolean, active: boolean): void {
    if (this.alive !== alive || this.active !== active) {
      this.alive = alive;
      this.active = active;
      this.cached = undefined;
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached && this.cached.w === width) return [this.cached.line];
    const m = this.member;
    const state = !this.alive ? dim("× dead") : this.active ? "●" + fg("32", " working") : dim("○ idle");
    const head = `${bold(m.name)}${dim(` (${m.type})`)}  ${state}`;
    const suffix = memberFg(m, `${"─".repeat(Math.max(1, width - 5 - visibleWidth(head)))}╮`);
    this.cached = { w: width, line: truncateToWidth(`${memberFg(m, "╭─ ")}${head} ${suffix}`, width) };
    return [this.cached.line];
  }
}

/** Bottom border: ╰──────────────╯ */
class CellBottom implements Component {
  private cached?: { w: number; line: string };
  private member: Member;

  constructor(member: Member) {
    this.member = member;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached && this.cached.w === width) return [this.cached.line];
    const line = memberFg(this.member, `╰${"─".repeat(Math.max(1, width - 2))}╯`);
    this.cached = { w: width, line };
    return [line];
  }
}

export class AgentCell {
  readonly root: VStack;
  private top: CellTop;
  private tail: Tail;
  readonly scrollView: ScrollView;
  private lines: string[] = [];

  constructor(member: Member) {
    this.top = new CellTop(member);
    this.tail = new Tail();
    this.scrollView = new ScrollView(this.tail, { follow: "end", scrollbar: "auto" });
    this.root = new VStack();
    this.root.addChild(this.top);
    this.root.addChild(this.scrollView, { basis: 0, grow: 1, minSize: 1 });
    this.root.addChild(new CellBottom(member));
  }

  setScreen(lines: string[], alive: boolean, active: boolean): void {
    this.lines = lines.slice(-TAIL_KEEP);
    this.top.set(alive, active);
    // 掐掉前后空行：空态 TUI（如 hermes 只有底部提示符）也能立刻看见内容
    const kept = [...this.lines];
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    let start = 0;
    while (start < kept.length && kept[start]!.trim() === "") start++;
    this.tail.set(kept.slice(start));
  }
}
