// 纯函数：文本差异算法（无 CodeMirror / Tauri 依赖，便于单元测试）。
// 由 diff.ts 导入，UI 逻辑与算法解耦。

export type Op = "same" | "del" | "add";

export interface DiffOp {
  op: Op;
  a: number;
  b: number;
}

export interface Hunk {
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
  firstOpIndex: number;
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function normalize(s: string, trim: boolean, lower: boolean): string {
  let t = s;
  if (trim) t = t.trim();
  if (lower) t = t.toLowerCase();
  return t;
}

// 基于最长公共子序列（LCS）的线性空间 diff：返回逐行的 same/del/add 操作序列。
export function computeDiff(aLines: string[], bLines: string[]): DiffOp[] {
  const n = aLines.length;
  const m = bLines.length;
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint32Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ op: "same", a: i, b: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "del", a: i, b: -1 });
      i++;
    } else {
      out.push({ op: "add", a: -1, b: j });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: "del", a: i, b: -1 });
    i++;
  }
  while (j < m) {
    out.push({ op: "add", a: -1, b: j });
    j++;
  }
  return out;
}

// 将逐行操作序列合并为连续差异块（hunk）。
export function buildHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "same") {
      i++;
      continue;
    }
    const prevA = i > 0 ? ops[i - 1].a : -1;
    const prevB = i > 0 ? ops[i - 1].b : -1;
    const leftStart = ops[i].a >= 0 ? ops[i].a : prevA + 1;
    const rightStart = ops[i].b >= 0 ? ops[i].b : prevB + 1;
    let leftEnd = leftStart;
    let rightEnd = rightStart;
    let j = i;
    while (j < ops.length && ops[j].op !== "same") {
      if (ops[j].a >= 0) leftEnd = ops[j].a + 1;
      if (ops[j].b >= 0) rightEnd = ops[j].b + 1;
      j++;
    }
    hunks.push({ leftStart, leftEnd, rightStart, rightEnd, firstOpIndex: i });
    i = j;
  }
  return hunks;
}
