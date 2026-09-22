// zebra — @-mention autocomplete provider for pi-tui Editor
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../../deps/pi-tui/dist/index.js";
import { fuzzyFilter } from "../../deps/pi-tui/dist/index.js";
import type { Member } from "../types.ts";

/** Trigger on "@", suggest member names, apply as "@name ". */
export class MentionProvider implements AutocompleteProvider {
  triggerCharacters = ["@"];

  private members: Member[];

  constructor(members: Member[]) {
    this.members = members;
  }

  /** Find the @token immediately before the cursor on this line. */
  private extractPrefix(line: string, cursorCol: number): string | null {
    let start = -1;
    for (let i = cursorCol - 1; i >= 0; i--) {
      const ch = line[i]!;
      if (ch === "@") {
        start = i;
        break;
      }
      if (/\s/.test(ch)) break;
    }
    if (start < 0) return null;
    return line.slice(start, cursorCol);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? "";
    const prefix = this.extractPrefix(line, cursorCol);
    if (prefix === null || prefix.length === 0) return null;
    const query = prefix.slice(1);
    const items: AutocompleteItem[] = fuzzyFilter(this.members, query, (m) => m.name).map((m) => ({
      value: m.name,
      label: `@${m.name}`,
      description: `${m.type}${m.id !== m.name ? ` (${m.id})` : ""}`,
    }));
    if (items.length === 0) return null;
    return { items, prefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const replacement = `@${item.value} `;
    const next = line.slice(0, start) + replacement + line.slice(cursorCol);
    const out = [...lines];
    out[cursorLine] = next;
    return { lines: out, cursorLine, cursorCol: start + replacement.length };
  }
}
