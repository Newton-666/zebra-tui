// zebra — shared types

export type MemberType = "pi" | "hermes" | "codex" | "kimi" | "custom";

export interface Member {
  id: string;            // "pi" | "hermes" | ... | "m3"
  name: string;          // display name
  type: MemberType;
  command: string;       // interactive launch command (run inside tmux pane)
  resumeCommand?: string; // best-effort resume variant (used when pane died)
  color?: string;        // ansi fg code base, e.g. "36"
}

export interface TeamConfig {
  id: string;            // session dir name
  name: string;          // team display name
  createdAt: string;
  cwd: string;           // working dir for agent panes
  tmuxSession: string;   // tmux session name
  members: Member[];
  paneIds?: Record<string, string>; // memberId -> tmux pane id (persisted)
  gridRatios?: number[];            // 列宽比例（可拖拽分隔线调整）
}

export type HistoryEvent =
  | { t: string; type: "team_created"; config: TeamConfig }
  | { t: string; type: "dispatch"; to: string[]; text: string }   // to = member ids
  | { t: string; type: "screen"; member: string; lines: string[] } // captured pane screen (ansi)
  | { t: string; type: "note"; text: string };                      // system notes

export const DEFAULT_COMMANDS: Record<MemberType, { command: string; resume?: string }> = {
  pi: { command: "pi", resume: "pi -c || pi" },
  hermes: { command: "hermes chat", resume: "hermes chat --continue || hermes chat" },
  codex: { command: "codex", resume: "codex resume --last || codex" },
  kimi: { command: "kimi", resume: "kimi -c || kimi" },
  custom: { command: "" },
};

export const MEMBER_COLORS: Record<string, string> = {
  pi: "36",      // cyan
  hermes: "35",  // magenta
  codex: "33",   // yellow
  kimi: "32",    // green
  custom: "34",  // blue
};
