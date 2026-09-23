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

/** 每格保留的历史行数上限 */
const MAX_LOG_LINES = 800;
/** 历史与「当前画面」之间的分隔标记 */
const FRAME_SEPARATOR = "\x1b[2m····· 当前画面 ·····\x1b[22m";

export class AgentCell {
  readonly root: VStack;
  private top: CellTop;
  private tail: Tail;
  readonly scrollView: ScrollView;
  private lines: string[] = [];
  private log: string[] = [];   // 已滚出屏幕的历史行（连续流水）
  private last: string[] = [];  // 最近一次画面

  constructor(member: Member) {
    this.top = new CellTop(member);
    this.tail = new Tail();
    this.scrollView = new ScrollView(this.tail, {
      follow: "end",
      scrollbar: "auto",
      // 关键：chain 会把滚到头的剩余量传给 primary（第一格）→ 表现为「滚一个，别的也动」
      overscroll: "contain",
    });
    this.root = new VStack();
    this.root.addChild(this.top);
    this.root.addChild(this.scrollView, { basis: 0, grow: 1, minSize: 1 });
    this.root.addChild(new CellBottom(member));
  }

  /** 归一化一屏：去掉前后空行（空态 TUI 也能看见内容） */
  private static normalize(lines: string[]): string[] {
    const kept = [...lines].slice(-TAIL_KEEP);
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    let start = 0;
    while (start < kept.length && kept[start]!.trim() === "") start++;
    return kept.slice(start);
  }

  /** 比对前后两屏：把「已被顶掉」的行追加进历史流水（只保留一份当前画面，不再叠整帧） */
  private appendVanished(prev: string[], next: string[]): void {
    // 找出 prev 整体上移了多少行（prev[s..] == next[0..]）→ 前 s 行是被顶掉的历史
    let shift = -1;
    for (let s = 0; s < prev.length; s++) {
      const n = prev.length - s;
      if (n === 0 || n > next.length) continue;
      let ok = true;
      for (let i = 0; i < n; i++) {
        if (prev[s + i] !== next[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        shift = s;
        break;
      }
    }
    // shift>0：顶掉了 s 行；shift==0：画面原地更新；-1：整屏换掉 → 旧屏全部入历史
    const gone = shift > 0 ? prev.slice(0, shift) : shift === 0 ? [] : prev;
    for (const line of gone) {
      if (!line.trim()) continue;
      if (this.log[this.log.length - 1] === line) continue;
      this.log.push(line);
    }
    if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
  }

  setScreen(lines: string[], alive: boolean, active: boolean): void {
    this.lines = lines.slice(-TAIL_KEEP);
    this.top.set(alive, active);
    const frame = AgentCell.normalize(this.lines);
    if (this.last.length === 0) {
      this.last = frame;
    } else {
      this.appendVanished(this.last, frame);
      this.last = frame;
    }
    const body = this.log.length ? [...this.log, FRAME_SEPARATOR, ...this.last] : [...this.last];
    this.tail.set(body);
  }
}
