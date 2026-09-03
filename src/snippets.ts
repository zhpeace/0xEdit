import { snippet, autocompletion, type CompletionResult, type CompletionContext } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { t } from "./i18n";

export interface SnippetDef {
  trigger: string;
  name: string;
  body: string;
}

const PREFIX = "uec.snip.";

export function listSnippets(): SnippetDef[] {
  const out: SnippetDef[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        const v = localStorage.getItem(k);
        if (v) out.push(JSON.parse(v) as SnippetDef);
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => a.trigger.localeCompare(b.trigger));
}

export function saveSnippet(def: SnippetDef): void {
  try {
    localStorage.setItem(PREFIX + def.trigger.toLowerCase(), JSON.stringify(def));
  } catch {
    /* ignore */
  }
}

export function deleteSnippet(trigger: string): void {
  try {
    localStorage.removeItem(PREFIX + trigger.toLowerCase());
  } catch {
    /* ignore */
  }
}

export function snippetCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\w*$/);
  if (!word || word.from === word.to) return null;
  const q = word.text.toLowerCase();
  const defs = listSnippets().filter((d) => d.trigger.toLowerCase().startsWith(q));
  if (!defs.length) return null;
  return {
    from: word.from,
    options: defs.map((d) => ({
      label: d.trigger,
      detail: d.name,
      boost: 80,
      apply: snippet(d.body),
    })),
  };
}

export function snippetsExtension(): Extension {
  return autocompletion({ override: [snippetCompletionSource] });
}

export function snippetManagerDialog(): void {
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal" style="min-width:520px;">
      <div class="modal-title">${t("代码片段")}</div>
      <div class="modal-body">
        <div class="fs-row">
          <input class="fs-input" id="sn-trigger" placeholder="${t("触发词（如 if / for）")}" spellcheck="false" style="width:120px;flex:0 0 120px;"/>
          <input class="fs-input" id="sn-name" placeholder="${t("名称")}" spellcheck="false"/>
        </div>
        <textarea id="sn-body" class="script-editor" style="height:120px;" spellcheck="false" placeholder="${t("模板内容，$1/$2 为光标停留点（Tab 跳转）")}"></textarea>
        <div class="modal-actions" style="margin:8px 0;">
          <button class="primary" id="sn-add">${t("保存/更新")}</button>
        </div>
        <div class="rec-list" id="sn-list" style="max-height:220px;"></div>
        <div class="modal-actions" style="margin-top:12px;"><button class="primary" data-close>${t("关闭")}</button></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const listEl = modal.querySelector<HTMLElement>("#sn-list")!;
  const render = () => {
    const defs = listSnippets();
    listEl.innerHTML = "";
    if (!defs.length) {
      listEl.innerHTML = `<div class="outline-empty">${t("（暂无片段，输入触发词/模板后保存）")}</div>`;
      return;
    }
    for (const d of defs) {
      const row = document.createElement("div");
      row.className = "rec-item";
      row.innerHTML = `<span class="rec-name">${escapeHtml(d.trigger)} — ${escapeHtml(d.name)}</span><span class="rec-btns"><button class="search-btn" data-edit>${t("编辑")}</button><button class="search-btn" data-del>${t("删除")}</button></span>`;
      row.querySelector("[data-edit]")!.addEventListener("click", (_e) => {
        _e.stopPropagation();
        (modal.querySelector("#sn-trigger") as HTMLInputElement).value = d.trigger;
        (modal.querySelector("#sn-name") as HTMLInputElement).value = d.name;
        (modal.querySelector("#sn-body") as HTMLTextAreaElement).value = d.body;
      });
      row.querySelector("[data-del]")!.addEventListener("click", (_e) => {
        _e.stopPropagation();
        deleteSnippet(d.trigger);
        render();
      });
      listEl.appendChild(row);
    }
  };

  modal.querySelector("#sn-add")!.addEventListener("click", () => {
    const trigger = (modal.querySelector("#sn-trigger") as HTMLInputElement).value.trim();
    const name = (modal.querySelector("#sn-name") as HTMLInputElement).value.trim() || trigger;
    const body = (modal.querySelector("#sn-body") as HTMLTextAreaElement).value;
    if (!trigger || !body) {
      window.alert(t("触发词和模板内容不能为空"));
      return;
    }
    saveSnippet({ trigger, name, body });
    render();
  });
  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}