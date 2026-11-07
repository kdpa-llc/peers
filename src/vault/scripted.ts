/**
 * The demo bot's edits (ADR 0003's demo engine): simple, recognisable changes to the lines a
 * note marks, so demo mode and the tests show the whole notes flow with the same output
 * every time.
 */

export type NoteSpec = { id: string; from: number; to: number; toLine?: number; instruction: string; tool: string };

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

const stripItem = (line: string): string => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim();

export type PageFormat = "markdown" | "org";

/** The edit the scripted bot makes for one instruction, in the page's own format. */
export function transform(block: string[], instruction: string, format: PageFormat = "markdown"): string[] {
  const i = instruction.toLowerCase();
  const text = block.filter((l) => l.trim()).map(stripItem);
  if (/\b(delete|remove)\b/.test(i)) return [];
  if (/\btable\b/.test(i)) {
    const rows = block.some((l) => /^\s*(?:[-*+]|\d+[.)])\s/.test(l)) ? text : sentences(text.join(" "));
    return ["| Item | Owner | Date |", format === "org" ? "|------+-------+------|" : "| --- | --- | --- |", ...rows.map((r) => {
      const date = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.? \d{1,2}\b/.exec(r)?.[0] ?? "";
      const owner = /\b(Sam|Maya|Dana|Leo|Ana)\b/.exec(r)?.[0] ?? "";
      return `| ${r.replace(/\|/g, "/")} | ${owner} | ${date} |`;
    })];
  }
  if (/\b(short|shorter|shorten|concise|tighten|trim)\b/.test(i)) {
    return block.map((l) => {
      const lead = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#+\s+)?/.exec(l)?.[0] ?? "";
      const first = sentences(l.slice(lead.length))[0] ?? "";
      return l.trim() ? `${lead}${first}` : l;
    });
  }
  if (/\b(bold|emphasi[sz]e|highlight|stress)\b/.test(i)) {
    return block.map((l) => {
      if (!l.trim()) return l;
      const lead = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX-]\]\s+)?|#+\s+|\*+\s+)?/.exec(l)?.[0] ?? "";
      const mark = format === "org" ? "*" : "**";
      return `${lead}${mark}${l.slice(lead.length).trim()}${mark}`;
    });
  }
  if (/\b(bullets?|list)\b/.test(i)) return sentences(text.join(" ")).map((s) => `- ${s}`);
  if (/\b(friendl|warm|kind)/.test(i)) return block.map((l) => (l.trim() ? `${l.replace(/\.$/, "")}. Thanks, everyone!` : l));
  if (format === "org") return [...block, "", "#+BEGIN_QUOTE", `Scripted bot: noted ${instruction || "(no instruction)"}`, "#+END_QUOTE"];
  return [...block, "", "> [!note] Scripted bot", `> Noted: ${instruction || "(no instruction)"}`];
}

export function applyNotes(lines: string[], notes: NoteSpec[], format: PageFormat = "markdown"): string[] {
  let out = [...lines];
  const ordered = [...notes].filter((n) => n.from >= 1).sort((a, b) => b.from - a.from);
  for (const n of ordered) {
    const from = Math.min(n.from, out.length);
    const to = Math.min(Math.max(n.to, from), out.length);
    const block = out.slice(from - 1, to);
    if (n.toLine && /\bmove\b/i.test(n.instruction)) {
      const without = [...out.slice(0, from - 1), ...out.slice(to)];
      const target = n.toLine > to ? n.toLine - block.length : n.toLine;
      out = [...without.slice(0, target), ...block, ...without.slice(target)];
      continue;
    }
    out = [...out.slice(0, from - 1), ...transform(block, n.instruction, format), ...out.slice(to)];
  }
  return out;
}
