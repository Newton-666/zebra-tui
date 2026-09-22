// zebra — screen poller: diff member panes, auto-revive dead panes, feed cells + history
import { appendEvent } from "./team.ts";
import { captureScreen, paneAlive } from "./agents.ts";
import type { Member } from "./types.ts";

export interface MemberFeed {
  lines: string[];      // current screen (ansi)
  changedAt: number;    // last change timestamp
  alive: boolean;
}

const MAX_REVIVES = 5;
const REVIVE_COOLDOWN_MS = 8000;

export class ScreenPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private last: Map<string, string> = new Map();
  readonly feeds: Map<string, MemberFeed> = new Map();
  private reviveAttempts: Record<string, number> = {};
  private lastRevive: Record<string, number> = {};
  onChange: (() => void) | undefined;

  private members: Member[];
  private sessionId: string;
  private intervalMs: number;
  private getPaneIds: () => string[];
  private revivePane: (m: Member, paneId: string) => void;

  constructor(
    getPaneIds: () => string[],
    members: Member[],
    sessionId: string,
    revivePane: (m: Member, paneId: string) => void,
    intervalMs = 350,
  ) {
    this.getPaneIds = getPaneIds;
    this.members = members;
    this.sessionId = sessionId;
    this.revivePane = revivePane;
    this.intervalMs = intervalMs;
    for (const m of members) {
      this.feeds.set(m.id, { lines: [], changedAt: 0, alive: true });
    }
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    let anyChange = false;
    this.members.forEach((m, i) => {
      const paneId = this.getPaneIds()[i];
      if (!paneId) return;
      const feed = this.feeds.get(m.id)!;
      try {
        if (!paneAlive(paneId)) {
          if (feed.alive) {
            feed.alive = false;
            feed.lines = [`× ${m.name} 退出了，正在自动复活…`];
            anyChange = true;
          }
          this.tryRevive(m, paneId);
          return;
        }
        if (!feed.alive) {
          feed.alive = true;
          feed.changedAt = Date.now();
          anyChange = true;
          appendEvent(this.sessionId, {
            t: new Date().toISOString(),
            type: "note",
            text: `${m.name} 已复活`,
          });
        }
        const lines = captureScreen(paneId);
        const hash = lines.join("\u0001");
        if (this.last.get(m.id) !== hash) {
          this.last.set(m.id, hash);
          feed.lines = lines;
          feed.changedAt = Date.now();
          anyChange = true;
          try {
            appendEvent(this.sessionId, { t: new Date().toISOString(), type: "screen", member: m.id, lines });
          } catch {
            /* history is best-effort */
          }
        }
      } catch {
        return;
      }
    });
    if (anyChange) this.onChange?.();
  }

  private tryRevive(m: Member, paneId: string): void {
    const now = Date.now();
    if ((this.reviveAttempts[m.id] ?? 0) >= MAX_REVIVES) return;
    if (now - (this.lastRevive[m.id] ?? 0) < REVIVE_COOLDOWN_MS) return;
    this.reviveAttempts[m.id] = (this.reviveAttempts[m.id] ?? 0) + 1;
    this.lastRevive[m.id] = now;
    try {
      this.revivePane(m, paneId);
      appendEvent(this.sessionId, {
        t: new Date().toISOString(),
        type: "note",
        text: `自动复活 ${m.name}（第 ${this.reviveAttempts[m.id]} 次）`,
      });
    } catch {
      /* next cooldown retries */
    }
  }
}
