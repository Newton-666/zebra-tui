// zebra — tiny ansi helpers
const ESC = "\x1b[";

export const fg = (code: string, s: string) => `${ESC}${code}m${s}${ESC}0m`;
export const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
export const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
export const inverse = (s: string) => `${ESC}7m${s}${ESC}27m`;

export function memberFg(member: { color?: string }, s: string): string {
  return fg(member.color || "36", s);
}

export const dot = (active: boolean, member: { color?: string }) =>
  memberFg(member, active ? "●" : "○");

// Krystal 蓝色调色板（编辑器边框 / 品牌胶囊）
export const BLUE = "38;5;39";        // 主蓝
export const BLUE_LIGHT = "38;5;45";  // 浅蓝
export const BG_BLUE = "48;5;24";     // 深蓝底
export const FG_WHITE = "38;5;231";
export const bg = (code: string, s: string) => `${ESC}${code}m${s}${ESC}0m`;

/** 胶囊标签：一次性发底色+前景色（避免嵌套 reset 互相清掉） */
export const chip = (text: string, bgCode = "48;5;25", fgCode = "38;5;231") =>
  `${ESC}${bgCode}m${ESC}${fgCode}m${text}${ESC}0m`;
