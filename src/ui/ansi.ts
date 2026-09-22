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
