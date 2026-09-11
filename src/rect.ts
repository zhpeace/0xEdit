import { EditorView, ViewUpdate, keymap } from "@codemirror/view";
import { EditorSelection, Prec } from "@codemirror/state";
import { computeRectRanges, type RectLine } from "./rect-core";

let columnMode = false;
// 键盘矩形选区的锚点（第一角）；鼠标拖选会更新，退出列模式时清除；
// 纯方向键移动光标时保留，供 Shift+方向键从原矩形继续扩展
let rectAnchor: Pos | null = null;
export function setColumnMode(v: boolean) {
  columnMode = v;
  if (!v) rectAnchor = null;
}
export function isColumnMode() {
  return columnMode;
}

interface MouseSelectionStyle {
  get: (curEvent: MouseEvent, extend: boolean, multiple: boolean) => EditorSelection;
  update: (update: ViewUpdate) => boolean | void;
}
type MakeSelectionStyle = (view: EditorView, event: MouseEvent) => MouseSelectionStyle | null;

interface Pos {
  line: number;
  col: number;
}

function posAt(view: EditorView, event: MouseEvent): Pos {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return { line: 1, col: 0 };
  const line = view.state.doc.lineAt(pos);
  return { line: line.number, col: pos - line.from };
}

class RectStyle implements MouseSelectionStyle {
  private start: Pos;

  constructor(
    private view: EditorView,
    start: Pos,
  ) {
    this.start = start;
  }

  update(_update: ViewUpdate) {
    return true;
  }

  get(curEvent: MouseEvent): EditorSelection {
    const cur = posAt(this.view, curEvent);
    const doc = this.view.state.doc;
    const lines: RectLine[] = [];
    for (let l = 1; l <= doc.lines; l++) {
      const line = doc.line(l);
      lines.push({ from: line.from, length: line.length });
    }
    const ranges = computeRectRanges(this.start, cur, lines);
    if (ranges.length === 0) return EditorSelection.create([EditorSelection.cursor(doc.length)]);
    let mainIndex = 0;
    const fromLine = Math.min(this.start.line, cur.line);
    for (let i = 0; i < ranges.length; i++) {
      if (fromLine + i === cur.line) mainIndex = i;
    }
    return EditorSelection.create(
      ranges.map((r) => EditorSelection.range(r.from, r.to)),
      mainIndex,
    );
  }
}

const makeStyle: MakeSelectionStyle = (view, event) => {
  if (!columnMode && !event.altKey) return null;
  if (!view.state.doc.length && event.button !== 0) return null;
  const start = posAt(view, event);
  rectAnchor = start; // 鼠标开始拖选：以按下位置为矩形锚点
  return new RectStyle(view, start);
};

export const rectangleSelection = EditorView.mouseSelectionStyle.of(makeStyle);

// ---------- 键盘矩形扩展（列编辑模式下 Shift + 方向键） ----------

function rectPosFromOffset(view: EditorView, offset: number): Pos {
  const clamped = Math.max(0, Math.min(offset, view.state.doc.length));
  const line = view.state.doc.lineAt(clamped);
  return { line: line.number, col: clamped - line.from };
}

function rectLinesOf(view: EditorView): RectLine[] {
  const doc = view.state.doc;
  const lines: RectLine[] = [];
  for (let l = 1; l <= doc.lines; l++) {
    const line = doc.line(l);
    lines.push({ from: line.from, length: line.length });
  }
  return lines;
}

function applyRectSelection(view: EditorView, headPos: Pos, anchor: Pos): boolean {
  const ranges = computeRectRanges(anchor, headPos, rectLinesOf(view));
  if (ranges.length === 0) return false;
  let mainIndex = 0;
  const fromLine = Math.min(anchor.line, headPos.line);
  for (let i = 0; i < ranges.length; i++) {
    if (fromLine + i === headPos.line) mainIndex = i;
  }
  view.dispatch({
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(r.from, r.to)),
      mainIndex,
    ),
    scrollIntoView: true,
  });
  return true;
}

// 计算上下移动后的目标位置（保持列，短行截断到行尾）
function lineTarget(view: EditorView, delta: number, col: number): number {
  const head = view.state.selection.main.head;
  const curLine = view.state.doc.lineAt(head).number;
  const target = curLine + delta;
  if (target < 1 || target > view.state.doc.lines) return head;
  const line = view.state.doc.line(target);
  return line.from + Math.min(col, line.length);
}

// 计算左右移动后的目标位置（同列内移动，不跨行）
// 左移：以选区左边界为移动端（range 的 head 在右端，若用 head 计算会卡住）；
// 右移：以选区右边界为移动端
function charTarget(view: EditorView, delta: number): number {  const sel = view.state.selection.main;
  const leftPos = Math.min(sel.from, sel.head);
  const rightPos = Math.max(sel.from, sel.head);
  const headLine = view.state.doc.lineAt(sel.head);
  if (delta < 0) {
    const leftCol = leftPos - view.state.doc.lineAt(leftPos).from;
    const ncol = Math.max(0, leftCol - 1);
    return headLine.from + Math.min(ncol, headLine.length);
  }
  const rightCol = rightPos - view.state.doc.lineAt(rightPos).from;
  const ncol = rightCol + 1;
  return headLine.from + Math.min(ncol, headLine.length);
}

function shiftArrow(view: EditorView, move: (v: EditorView, col: number) => number): boolean {
  if (!columnMode) return false;
  const head = view.state.selection.main.head;
  if (!rectAnchor) rectAnchor = rectPosFromOffset(view, head);
  const col = head - view.state.doc.lineAt(head).from;
  const next = move(view, col);
  if (next === head) return true; // 已到边界，保持现有选区
  return applyRectSelection(view, rectPosFromOffset(view, next), rectAnchor);
}

// 纯方向键的水平移动：head 列 ±1（折叠后移动光标）
function headCharTarget(view: EditorView, delta: number): number {
  const sel = view.state.selection.main;
  const head = sel.head;
  const line = view.state.doc.lineAt(head);
  const ncol = Math.max(0, Math.min(head - line.from + delta, line.length));
  return line.from + ncol;
}

// 纯方向键：折叠选区为光标并移动（不选择内容），保留 rectAnchor，
// 使后续 Shift+方向键能从原矩形继续扩展（多行矩形不被破坏）。
// 非列模式 / 无选区 → 交还默认处理（普通光标移动）。
function plainArrow(view: EditorView, move: (v: EditorView, col: number) => number): boolean {
  if (!columnMode) return false;
  const sel = view.state.selection.main;
  if (sel.from === sel.head) return false; // 无选区 → 默认移动光标
  const head = sel.head;
  const col = head - view.state.doc.lineAt(head).from;
  const next = move(view, col);
  if (next === head) return false; // 已在文档/行边界，交还默认（默认同样停住）
  view.dispatch({ selection: EditorSelection.cursor(next), scrollIntoView: true });
  return true;
}

export const rectKeyboard = Prec.high(
  keymap.of([
    { key: "Shift-ArrowUp", run: (v) => shiftArrow(v, (vv, col) => lineTarget(vv, -1, col)) },
    { key: "Shift-ArrowDown", run: (v) => shiftArrow(v, (vv, col) => lineTarget(vv, 1, col)) },
    { key: "Shift-ArrowLeft", run: (v) => shiftArrow(v, (_vv, _col) => charTarget(_vv, -1)) },
    { key: "Shift-ArrowRight", run: (v) => shiftArrow(v, (_vv, _col) => charTarget(_vv, 1)) },
    { key: "ArrowUp", run: (v) => plainArrow(v, (vv, col) => lineTarget(vv, -1, col)) },
    { key: "ArrowDown", run: (v) => plainArrow(v, (vv, col) => lineTarget(vv, 1, col)) },
    { key: "ArrowLeft", run: (v) => plainArrow(v, (_vv, _col) => headCharTarget(_vv, -1)) },
    { key: "ArrowRight", run: (v) => plainArrow(v, (_vv, _col) => headCharTarget(_vv, 1)) },
  ]),
);