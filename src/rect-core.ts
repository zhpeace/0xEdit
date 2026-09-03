// 纯函数：矩形（列块）选择的几何计算（无 CodeMirror 依赖，便于单元测试）。
// 由 rect.ts 导入，UI 选择与算法解耦。

export interface RectPos {
  line: number; // 1-based
  col: number; // 0-based
}

export interface RectLine {
  from: number; // 该行在文档中的起始偏移
  length: number; // 该行长度（不含换行符）
}

// 给定矩形选择的两个角点（start、cur）与各行几何，返回各行的选择区间 [from, to)。
// 行号按 1-based；超出行尾的部分会被夹到行尾（区间可能为空，与经典编辑器行为一致）。
export function computeRectRanges(
  start: RectPos,
  cur: RectPos,
  lines: RectLine[],
): Array<{ from: number; to: number }> {
  const fromLine = Math.min(start.line, cur.line);
  const toLine = Math.max(start.line, cur.line);
  const colA = Math.min(start.col, cur.col);
  const colB = Math.max(start.col, cur.col);
  const ranges: Array<{ from: number; to: number }> = [];
  for (let l = fromLine; l <= toLine; l++) {
    const line = lines[l - 1];
    if (!line) continue;
    const from = line.from + Math.min(colA, line.length);
    const to = line.from + Math.min(colB, line.length);
    ranges.push({ from, to });
  }
  return ranges;
}
