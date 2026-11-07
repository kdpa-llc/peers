/**
 * Line diff (Myers, O(ND)) used for change bars on the page and for checking whether a
 * note's marked text actually changed. Hunks use 1-based inclusive line numbers; an empty
 * side has `end = start - 1`.
 */

export type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number };

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function diffLines(aText: string, bText: string, maxEdits = 4000): Hunk[] {
  const a = splitLines(aText);
  const b = splitLines(bText);
  // Trim the common head and tail; most edits are local.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  if (A.length === 0 && B.length === 0) return [];
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) {
    // Too different to diff cheaply: one hunk covering everything that differs.
    return [{ aStart: head + 1, aEnd: head + n, bStart: head + 1, bEnd: head + m }];
  }
  // Backtrack to collect edit operations.
  const ops: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("="); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push("+"); y--; } else { ops.push("-"); x--; }
    }
  }
  while (x > 0 && y > 0) { ops.push("="); x--; y--; }
  while (x > 0) { ops.push("-"); x--; }
  while (y > 0) { ops.push("+"); y--; }
  ops.reverse();
  const hunks: Hunk[] = [];
  let ai = head;
  let bi = head;
  let cur: Hunk | undefined;
  for (const op of ops) {
    if (op === "=") {
      if (cur) { hunks.push(cur); cur = undefined; }
      ai++; bi++;
      continue;
    }
    cur ??= { aStart: ai + 1, aEnd: ai, bStart: bi + 1, bEnd: bi };
    if (op === "-") { ai++; cur.aEnd = ai; } else { bi++; cur.bEnd = bi; }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** Whether any hunk touches the 1-based inclusive line range in the old text. */
export function touches(hunks: Hunk[], lines: [number, number]): boolean {
  return hunks.some((h) => {
    if (h.aEnd < h.aStart) {
      // Pure insertion between aStart-1 and aStart: counts if inside or at the edge of the range.
      return h.aStart >= lines[0] && h.aStart <= lines[1] + 1;
    }
    return h.aStart <= lines[1] && h.aEnd >= lines[0];
  });
}
