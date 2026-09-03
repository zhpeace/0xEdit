import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

const toggleEffect = StateEffect.define<number>();
const clearEffect = StateEffect.define<void>();

const bookmarkPositions = StateField.define<number[]>({
  create: () => [],
  update(positions, tr) {
    let result = positions.map((p) => tr.changes.mapPos(p, -1)).filter((p) => p >= 0);
    for (const e of tr.effects) {
      if (e.is(toggleEffect)) {
        const pos = e.value;
        const idx = result.indexOf(pos);
        if (idx >= 0) result.splice(idx, 1);
        else result.push(pos);
      } else if (e.is(clearEffect)) {
        result = [];
      }
    }
    return result.sort((a, b) => a - b);
  },
});

class BookmarkMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-bookmark-mark";
    el.textContent = "●";
    return el;
  }
}

const bookmarkGutter = gutter({
  class: "cm-bookmark-gutter",
  markers: (view) => {
    const positions = view.state.field(bookmarkPositions);
    if (!positions.length) return [];
    const builder = new RangeSetBuilder<GutterMarker>();
    const doc = view.state.doc;
    for (const pos of positions) {
      if (pos > doc.length) continue;
      const line = doc.lineAt(Math.min(pos, doc.length));
      builder.add(line.from, line.from, new BookmarkMarker());
    }
    return builder.finish();
  },
  initialSpacer: () => new BookmarkMarker(),
  domEventHandlers: {
    mousedown: (view, line) => {
      view.dispatch({ effects: toggleEffect.of(line.from) });
      return true;
    },
  },
});

export function bookmarks(): import("@codemirror/state").Extension {
  return [bookmarkPositions, bookmarkGutter];
}

export function toggleBookmark(view: EditorView): boolean {
  try {
    view.dispatch({ effects: toggleEffect.of(view.state.doc.lineAt(view.state.selection.main.head).from) });
  } catch {
    return false;
  }
  return true;
}

export function nextBookmark(view: EditorView): boolean {
  const state = view.state;
  let positions: number[];
  try {
    positions = state.field(bookmarkPositions);
  } catch {
    return false;
  }
  if (!positions.length) return false;
  const cur = state.doc.lineAt(state.selection.main.head).number;
  let target = positions.map((p) => state.doc.lineAt(Math.min(p, state.doc.length)).number).find((n) => n > cur);
  if (target == null) target = state.doc.lineAt(Math.min(positions[0], state.doc.length)).number;
  const line = state.doc.line(target);
  view.dispatch({
    selection: { anchor: line.from },
    effects: [EditorView.scrollIntoView(line.from, { y: "center" })],
  });
  return true;
}

export function prevBookmark(view: EditorView): boolean {
  const state = view.state;
  let positions: number[];
  try {
    positions = state.field(bookmarkPositions);
  } catch {
    return false;
  }
  if (!positions.length) return false;
  const cur = state.doc.lineAt(state.selection.main.head).number;
  const lines = positions.map((p) => state.doc.lineAt(Math.min(p, state.doc.length)).number);
  let target = [...lines].reverse().find((n) => n < cur);
  if (target == null) target = state.doc.lineAt(Math.min(positions[positions.length - 1], state.doc.length)).number;
  const line = state.doc.line(target);
  view.dispatch({
    selection: { anchor: line.from },
    effects: [EditorView.scrollIntoView(line.from, { y: "center" })],
  });
  return true;
}

export function clearAllBookmarks(view: EditorView): boolean {
  view.dispatch({ effects: clearEffect.of() });
  return true;
}

export function bookmarkLines(view: EditorView, positions: number[]): boolean {
  if (!positions.length) {
    view.dispatch({ effects: clearEffect.of() });
    return true;
  }
  view.dispatch({
    effects: [clearEffect.of(), ...positions.map((p) => toggleEffect.of(p))],
  });
  return true;
}