import { EditorView, ViewUpdate } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { computeRectRanges, type RectLine } from "./rect-core";

let columnMode = false;
export function setColumnMode(v: boolean) {
  columnMode = v;
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
  return new RectStyle(view, posAt(view, event));
};

export const rectangleSelection = EditorView.mouseSelectionStyle.of(makeStyle);