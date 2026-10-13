/**
 * The one line diff in Panel.
 *
 * Two callers need the same answer and must never disagree about it: the gutter change bars
 * (this buffer against HEAD) and the conflict view (your buffer against what the agent just
 * wrote). If those two ever computed "changed" differently, the gutter would be quietly lying
 * about the file you are being asked to make a decision on.
 *
 * Not Myers. Common prefix and suffix are trimmed first, which is the whole diff for almost
 * every real edit, and the remaining middle gets an LCS table. A table is O(n·m), so a large
 * unrelated middle is declared "replaced" instead of being computed — an honest coarse answer
 * in a frame beats an exact one that drops a keystroke.
 */

/** Past this many lines in the middle, the table is not worth building. */
const MAX_TABLE = 1_200;

export type DiffRow = {
  kind: "same" | "add" | "del";
  /** 1-indexed line number in the "before" text. Absent on an added line. */
  before?: number;
  /** 1-indexed line number in the "after" text. Absent on a deleted line. */
  after?: number;
  text: string;
};

/** What the gutter needs: which lines of the CURRENT text are new or changed, and where lines
 *  were removed. `deleted` holds the line number that now SITS AFTER each removal. */
export type LineChanges = {
  added: Set<number>;
  modified: Set<number>;
  deleted: Set<number>;
};

/** One Git-style hunk in the current buffer. `afterIndex` is zero-based. */
export type DiffHunk = {
  /** Stable enough for one rendered buffer. Recomputed after every debounced edit. */
  id: string;
  /** First useful current line. Deletion-only hunks point at the line closing the gap. */
  line: number;
  fromLine: number;
  toLine: number;
  /** Current lines replaced when reverting this hunk. */
  afterIndex: number;
  afterCount: number;
  /** HEAD lines restored when reverting this hunk. */
  beforeLines: string[];
  /** Two quiet lines around the change, for the gutter popover. */
  preview: DiffRow[];
};

export type DiffAnalysis = LineChanges & { hunks: DiffHunk[] };

const split = (text: string): string[] => text.split("\n");

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = split(before);
  const b = split(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i++) rows.push({ kind: "same", before: i + 1, after: i + 1, text: a[i] });

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  if (midA.length * midB.length > MAX_TABLE * MAX_TABLE || midA.length > MAX_TABLE || midB.length > MAX_TABLE) {
    // Too big to pair up line by line. Say "this block was replaced" and mean it.
    midA.forEach((text, i) => rows.push({ kind: "del", before: head + i + 1, text }));
    midB.forEach((text, i) => rows.push({ kind: "add", after: head + i + 1, text }));
  } else {
    rows.push(...lcsRows(midA, midB, head));
  }

  for (let i = 0; i < tail; i++) {
    rows.push({
      kind: "same",
      before: a.length - tail + i + 1,
      after: b.length - tail + i + 1,
      text: a[a.length - tail + i],
    });
  }
  return rows;
}

/** The classic table, walked backwards. `offset` is how many identical lines were trimmed off
 *  the front, so the numbers that come out are numbers in the real file. */
function lcsRows(a: string[], b: string[], offset: number): DiffRow[] {
  const rows: DiffRow[] = [];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", before: offset + i + 1, after: offset + j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: "del", before: offset + i + 1, text: a[i] });
      i += 1;
    } else {
      rows.push({ kind: "add", after: offset + j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) rows.push({ kind: "del", before: offset + i + 1, text: a[i++] });
  while (j < b.length) rows.push({ kind: "add", after: offset + j + 1, text: b[j++] });
  return rows;
}

/**
 * Collapse a diff into gutter marks.
 *
 * A run of deletions immediately followed by a run of additions is an EDIT, not a removal plus
 * an insertion — that is what you did when you retyped a line, and drawing it as two separate
 * events is how a gutter ends up claiming you deleted half the file.
 */
export function analyzeChanges(before: string, after: string): DiffAnalysis {
  const changes: DiffAnalysis = {
    added: new Set(),
    modified: new Set(),
    deleted: new Set(),
    hunks: [],
  };
  if (before === after) return changes;

  const rows = lineDiff(before, after);
  let index = 0;
  const blocks: Array<{ start: number; end: number }> = [];
  while (index < rows.length) {
    if (rows[index].kind === "same") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < rows.length && rows[index].kind === "del") index += 1;
    const removed = index - start;
    const addStart = index;
    while (index < rows.length && rows[index].kind === "add") index += 1;
    const inserted = index - addStart;

    const paired = Math.min(removed, inserted);
    for (let n = 0; n < paired; n++) {
      const line = rows[addStart + n].after;
      if (line !== undefined) changes.modified.add(line);
    }
    for (let n = paired; n < inserted; n++) {
      const line = rows[addStart + n].after;
      if (line !== undefined) changes.added.add(line);
    }
    if (removed > paired) {
      // Lines vanished with nothing put in their place. Mark the line that closed the gap.
      const next = rows[index]?.after ?? rows[addStart + inserted - 1]?.after;
      changes.deleted.add(Math.max(1, next ?? 1));
    }
    blocks.push({ start, end: index });
  }

  // Git joins nearby edits when their three context lines overlap. The popover follows that
  // boundary, so what it previews is exactly the unit the backend stages.
  const groups: Array<{ start: number; end: number }> = [];
  for (const block of blocks) {
    const previous = groups[groups.length - 1];
    const quiet = previous ? block.start - previous.end : Number.POSITIVE_INFINITY;
    if (previous && quiet <= 6) previous.end = block.end;
    else groups.push({ ...block });
  }

  for (const [number, group] of groups.entries()) {
    const beforeGroup = rows.slice(0, group.start);
    const body = rows.slice(group.start, group.end);
    const afterIndex = beforeGroup.filter((row) => row.kind !== "del").length;
    const afterCount = body.filter((row) => row.kind !== "del").length;
    const beforeLines = body.filter((row) => row.kind !== "add").map((row) => row.text);
    const changedAfter = body
      .filter((row) => row.kind === "add" && row.after !== undefined)
      .map((row) => row.after!);
    const anchor = Math.max(1, Math.min(split(after).length, afterIndex + 1));
    const fromLine = changedAfter.length ? Math.min(...changedAfter) : anchor;
    const toLine = changedAfter.length ? Math.max(...changedAfter) : anchor;
    changes.hunks.push({
      id: `${number}:${group.start}:${group.end}`,
      line: fromLine,
      fromLine,
      toLine,
      afterIndex,
      afterCount,
      beforeLines,
      preview: rows.slice(Math.max(0, group.start - 2), Math.min(rows.length, group.end + 2)),
    });
  }
  return changes;
}

export function changedLines(before: string, after: string): LineChanges {
  return analyzeChanges(before, after);
}

/** Restore only one hunk. The caller dispatches the minimal text change, keeping undo native. */
export function revertedHunk(after: string, hunk: DiffHunk): string {
  const lines = split(after);
  lines.splice(hunk.afterIndex, hunk.afterCount, ...hunk.beforeLines);
  return lines.join("\n");
}
