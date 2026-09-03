import { EditorView } from "@codemirror/view";
import { t } from "./i18n";

const MAX = 20;
const hist: string[] = [];

export const clipListener = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return;
  for (const tr of u.transactions) {
    if (tr.isUserEvent("paste")) {
      const parts: string[] = [];
      tr.changes.iterChanges((_a, _b, _c, _d, inserted) => {
        if (inserted.length) parts.push(inserted.toString());
      });
      const text = parts.join("\n");
      if (text && !text.includes("\u0000")) {
        const idx = hist.indexOf(text);
        if (idx >= 0) hist.splice(idx, 1);
        hist.unshift(text);
        if (hist.length > MAX) hist.pop();
      }
    }
  }
});

export function clipboardHistory(): readonly string[] {
  return hist;
}

export function openClipHistory(view: EditorView, onToast: (m: string) => void) {
  if (!hist.length) {
    onToast(t("剪贴板历史为空"));
    return;
  }
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal" style="min-width:440px;">
      <div class="modal-title">${t("剪贴板历史（点击插入）")}</div>
      <div class="rec-list" id="ch-list"></div>
      <div class="modal-actions" style="margin-top:12px;"><button data-close class="primary">${t("关闭")}</button></div>
    </div>`;
  document.body.appendChild(modal);
  const list = modal.querySelector<HTMLElement>("#ch-list")!;
  const frag = document.createDocumentFragment();
  const insert = (text: string) => {
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    modal.remove();
    view.focus();
  };
  for (const item of hist) {
    const row = document.createElement("div");
    row.className = "rec-item";
    const pre = document.createElement("span");
    pre.className = "rec-name";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = item.length > 200 ? item.slice(0, 200) + "…" : item;
    const meta = document.createElement("span");
    meta.className = "rec-meta";
    meta.textContent = `${item.length} ${t("字")}`;
    row.append(pre, meta);
    row.addEventListener("click", () => insert(item));
    frag.appendChild(row);
  }
  list.appendChild(frag);

  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });
}