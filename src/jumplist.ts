import { EditorView } from "@codemirror/view";

const MAX = 300;
let back: number[] = [];
let fwd: number[] = [];

export const editPositionListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return;
  const userEdit = u.transactions.some((t) =>
    t.isUserEvent("input") ||
    t.isUserEvent("input.type") ||
    t.isUserEvent("paste") ||
    t.isUserEvent("delete") ||
    t.isUserEvent("undo") ||
    t.isUserEvent("redo") ||
    t.isUserEvent("move"),
  );
  if (!userEdit) return;
  const prevHead = u.startState.selection.main.head;
  if (back[back.length - 1] !== prevHead) {
    back.push(prevHead);
    if (back.length > MAX) back.shift();
  }
  fwd.length = 0;
});

function goto(view: EditorView, pos: number) {
  view.dispatch({
    selection: { anchor: pos },
    effects: [EditorView.scrollIntoView(pos, { y: "center" })],
  });
}

export function jumpBack(view: EditorView): boolean {
  const pos = back.pop();
  if (pos == null) return false;
  fwd.push(view.state.selection.main.head);
  goto(view, pos);
  return true;
}

export function jumpForward(view: EditorView): boolean {
  const pos = fwd.pop();
  if (pos == null) return false;
  back.push(view.state.selection.main.head);
  goto(view, pos);
  return true;
}

export function clearHistory() {
  back = [];
  fwd = [];
}