// zebra — team grid: proportional columns (grow = ratio) with draggable dividers
// 布局链: TeamGrid 暴露 [LAYOUT_NODE] 委托给内部 HStack（basis:0 + grow=比例 → 精确切分）
// 几何: compute(真实终端宽度) 直接推导，不经渲染回传，免疫 pi-tui 测量路径污染
import {
  HStack,
  VStack,
  type Component,
  type StackChild,
} from "../../deps/pi-tui/dist/index.js";
import { LAYOUT_NODE, getLayoutNode, type LayoutNode } from "../../deps/pi-tui/dist/layout-node.js";
import { dim, fg } from "../ui/ansi.ts";
import { columnCount, type Member } from "../types.ts";
import { AgentCell } from "./cell.ts";

export interface GridGeometry {
  colStarts: number[];
  dividerXs: number[];
  colWidths: number[];
  totalWidth: number;
}

const MIN_COL = 10;
const DIV = dim(fg("36", "│"));

/** 分隔线：作为真实组件参与布局（由布局裁剪高度），保证一定渲染出来 */
class Divider implements Component {
  render(_width: number): string[] {
    return new Array(400).fill(DIV);
  }
  invalidate(): void {}
}

export class TeamGrid implements Component {
  readonly columns: Member[][];
  readonly cells: Map<string, AgentCell>;
  ratios: number[];
  private lastGeometry: GridGeometry = { colStarts: [0], dividerXs: [], colWidths: [], totalWidth: 0 };
  private inner: HStack;

  private getWidth: () => number;
  private lastBuildKey = "";

  constructor(members: Member[], cells: Map<string, AgentCell>, ratios: number[] | undefined, getWidth: () => number) {
    const cols = columnCount(members.length);
    this.columns = Array.from({ length: cols }, () => []);
    members.forEach((m, i) => this.columns[i % cols]!.push(m));
    this.cells = cells;
    this.getWidth = getWidth;
    const n = this.columns.length;
    this.ratios = ratios && ratios.length === n ? [...ratios] : new Array(n).fill(1 / n);
    this.inner = this.build(this.layout(this.getWidth()).colWidths);
  }

  get geometry(): GridGeometry {
    return this.lastGeometry;
  }

  /** 用真实宽度重算 geometry（拖拽命中测试 / 引擎同步都以此为准） */
  compute(width: number): GridGeometry {
    this.lastGeometry = this.layout(width);
    return this.lastGeometry;
  }

  [LAYOUT_NODE](): LayoutNode {
    this.refresh();
    return getLayoutNode(this.inner)!;
  }

  invalidate(): void {
    this.lastBuildKey = "";
    this.inner.invalidate();
  }

  private layout(width: number): GridGeometry {
    const n = this.columns.length;
    const usable = Math.max(n * MIN_COL, width - (n - 1));
    const sum = this.ratios.reduce((a, b) => a + b, 0) || 1;
    const widths: number[] = [];
    let used = 0;
    for (let i = 0; i < n; i++) {
      if (i === n - 1) {
        widths.push(Math.max(MIN_COL, usable - used));
      } else {
        const w = Math.max(MIN_COL, Math.round((usable * this.ratios[i]!) / sum));
        widths.push(w);
        used += w;
      }
    }
    const starts: number[] = [];
    const dividers: number[] = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      starts.push(x);
      x += widths[i]!;
      if (i < n - 1) {
        dividers.push(x);
        x += 1;
      }
    }
    return { colStarts: starts, dividerXs: dividers, colWidths: widths, totalWidth: width };
  }

  /** 用精确列宽构建（basis 为数值 → 布局原样采用，与 compute() 完全一致） */
  private build(widths: number[]): HStack {
    const entries: StackChild[] = [];
    this.columns.forEach((col, i) => {
      if (i > 0) entries.push({ component: new Divider(), basis: 1, grow: 0, shrink: 0 });
      const stack = new VStack();
      for (const m of col) {
        // 列内成员垂直均分高度：grow 必须是正整数（pi-tui 对 grow 做 floor）
        stack.addChild(this.cells.get(m.id)!.root, { basis: 0, grow: 1, minSize: 4 });
      }
      entries.push({ component: stack as Component, basis: Math.max(MIN_COL, widths[i]!), grow: 0, shrink: 0 });
    });
    return new HStack(entries, { gap: 0 });
  }

  /** 宽度/比例变化时重建内部 HStack（每次布局走查前调用） */
  private refresh(): void {
    const w = this.getWidth();
    const key = `${w}|${this.ratios.join(",")}`;
    if (key === this.lastBuildKey) return;
    this.lastBuildKey = key;
    this.lastGeometry = this.layout(w);
    this.inner = this.build(this.lastGeometry.colWidths);
  }

  render(width: number): string[] {
    this.refresh();
    return this.inner.render(width);
  }

  hitDivider(x: number): number {
    // 命中区放宽到 ±3：避免按偏一点时事件漏给 alt-screen 的文本选区
    for (let i = 0; i < this.lastGeometry.dividerXs.length; i++) {
      if (Math.abs(x - this.lastGeometry.dividerXs[i]!) <= 3) return i;
    }
    return -1;
  }

  dragTo(dividerIdx: number, x: number): boolean {
    const g = this.lastGeometry;
    if (g.colWidths.length !== 2 || g.totalWidth <= 0) return false;
    const newLeft = Math.max(MIN_COL, Math.min(g.totalWidth - MIN_COL - 1, x));
    const r0 = newLeft / (g.totalWidth - 1);
    if (Math.abs(r0 - this.ratios[0]!) < 0.01) return false;
    this.ratios = [r0, 1 - r0];
    this.invalidate();
    this.onRatioChanged?.(this.ratios);
    return true;
  }
}
