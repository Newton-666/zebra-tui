// Krystal Bot — 回答段（渲染单元）：一段连续的 content = 一个对象
//
// 契约（2026-09-25 定）：**谁的内容谁自己持有**。
// 每个段对象只认自己的 Markdown / 文本 / 定格标记，`render` 永久绑自己那一个实例，
// 因此「新起一段」永远不会改变已存在段落的显示内容。
//
// 教训：此前所有回答块共用一个可变槽位（`let streamMd`），而块在 render 时才去读槽位当前值 ——
//   ① 新段一建就把槽位指过去 → 旧块立刻改显新文字（旧答复消失 + 同一段印两遍）；
//   ② `final` 的校准也写槽位 → 「先答后记」时把上一段长答案整段覆盖。
//   ③ 定格标记同样共用 → Transcript 的缓存时对时错，屏幕出现「半冻半跑」的混合状态。
// 现在这三样都随段走，互不干扰（回归：npm run test:render）。
import { Markdown, type Component, type MarkdownTheme } from "../../deps/pi-tui/dist/index.js";

export interface TextSegment {
  /** 落入 Transcript 的组件（本段唯一） */
  readonly comp: Component;
  /** 本段当前累积的文本（只读视图） */
  readonly text: string;
  /** 是否已定格（true 后 Transcript 转为缓存，不再逐帧重渲） */
  readonly done: boolean;
  /** 追加一段流式增量 */
  append(delta: string): void;
  /** 用权威全文校准后定格（final 事件；全文为空则保留流式内容，不覆盖） */
  finish(fullText?: string): void;
  /** 定格但保留内容（本段被思考/工具打断时用） */
  seal(): void;
  /** 本段是否从未有过有效文本（空回答判定） */
  isEmpty(): boolean;
}

export function createTextSegment(theme: MarkdownTheme): TextSegment {
  const md = new Markdown("", 1, 0, theme);
  let text = "";
  let done = false;
  const comp: Component = {
    get volatile() {
      return !done; // 只本段在流式中逐帧重渲；定格后恢复缓存
    },
    render(w: number): string[] {
      return md.render(w); // 永久绑本段的 md（不读任何共享变量）
    },
    invalidate(): void {
      md.invalidate();
    },
  };
  return {
    comp,
    get text() {
      return text;
    },
    get done() {
      return done;
    },
    append(delta: string): void {
      text += delta;
      md.setText(text.replace(/\s+$/, ""));
    },
    finish(fullText?: string): void {
      if (fullText && fullText.trim()) {
        text = fullText.trim();
        md.setText(text);
      }
      done = true;
    },
    seal(): void {
      done = true;
    },
    isEmpty(): boolean {
      return !text.trim();
    },
  };
}