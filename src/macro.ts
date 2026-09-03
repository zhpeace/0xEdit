import { EditorView } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { t } from "./i18n";

interface MacroStep {
  from: number;
  to: number;
  insert: string;
}

interface MacroState {
  recording: boolean;
  steps: MacroStep[] | null;
}

const beginEffect = StateEffect.define<void>();
const endEffect = StateEffect.define<void>();
const clearEffect = StateEffect.define<void>();
const setStepsEffect = StateEffect.define<MacroStep[]>();

const macroField = StateField.define<MacroState>({
  create: () => ({ recording: false, steps: null }),
  update(value, tr) {
    let result: MacroState = { recording: value.recording, steps: value.steps };
    for (const e of tr.effects) {
      if (e.is(beginEffect)) result = { recording: true, steps: [] };
      if (e.is(endEffect)) result = { recording: false, steps: result.steps || value.steps || [] };
      if (e.is(clearEffect)) result = { recording: false, steps: null };
      if (e.is(setStepsEffect)) result = { recording: false, steps: e.value };
    }
    if (result.recording && tr.docChanged) {
      const target = result.steps ?? [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        target.push({ from: fromA, to: toA, insert: inserted.toString() });
      });
      result.steps = target;
    }
    return result;
  },
});

export function macroExtension(): import("@codemirror/state").Extension {
  return macroField;
}

export function isRecording(state: { field: (f: typeof macroField) => MacroState }): boolean {
  try {
    return state.field(macroField).recording;
  } catch {
    return false;
  }
}

export function toggleRecordMacro(view: EditorView): boolean {
  try {
    const rec = view.state.field(macroField).recording;
    view.dispatch({ effects: rec ? endEffect.of() : beginEffect.of() });
  } catch {
    return false;
  }
  return true;
}

export function clearMacro(view: EditorView): boolean {
  try {
    view.dispatch({ effects: clearEffect.of() });
  } catch {
    return false;
  }
  return true;
}

export function runMacro(view: EditorView): boolean {
  let steps: MacroStep[] | null = null;
  try {
    steps = view.state.field(macroField).steps;
  } catch {
    return false;
  }
  if (!steps || steps.length === 0) return false;
  const stepList = [...steps];
  const specs = stepList.map((s) => ({ changes: { from: s.from, to: s.to, insert: s.insert } }));
  for (const spec of specs) view.dispatch(spec);
  return true;
}

const PREFIX = "uec.macro.";

export function saveMacroToStore(view: EditorView, name: string): boolean {
  let steps: MacroStep[] | null = null;
  try {
    steps = view.state.field(macroField).steps;
  } catch {
    return false;
  }
  if (!steps || steps.length === 0) return false;
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(steps));
  } catch {
    return false;
  }
  return true;
}

export function loadMacroFromStore(view: EditorView, name: string): boolean {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    if (!raw) return false;
    const steps = JSON.parse(raw) as MacroStep[];
    view.dispatch({ effects: setStepsEffect.of(steps) });
    return true;
  } catch {
    return false;
  }
}

export function listStoredMacros(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return out.sort();
}

export function deleteStoredMacro(name: string): void {
  try {
    localStorage.removeItem(PREFIX + name);
  } catch {
    /* ignore */
  }
}

export function storeMacroSteps(name: string, steps: MacroStep[]): boolean {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(steps));
    return true;
  } catch {
    return false;
  }
}

export function currentMacroSteps(view: EditorView): MacroStep[] | null {
  try {
    return view.state.field(macroField).steps;
  } catch {
    return null;
  }
}

export function macroManagerDialog(view: EditorView, onToast: (msg: string) => void) {
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal" style="min-width:420px;">
      <div class="modal-title">${t("宏管理")}</div>
      <div class="modal-body">
        <div class="fs-row">
          <input class="fs-input" id="mac-name" placeholder="${t("宏名称")}" spellcheck="false"/>
          <button class="search-btn" id="mac-save">${t("保存当前宏")}</button>
        </div>
        <div class="fs-row" style="margin-top:8px;">
          <button class="search-btn" id="mac-export">${t("导出")}</button>
          <button class="search-btn" id="mac-import">${t("导入")}</button>
          <input type="file" id="mac-import-file" accept="application/json,.json" style="display:none"/>
        </div>
        <div class="rec-list" id="mac-list"></div>
        <div class="modal-actions" style="margin-top:12px;"><button data-close class="primary">${t("关闭")}</button></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const listEl = modal.querySelector<HTMLElement>("#mac-list")!;
  const render = () => {
    const names = listStoredMacros();
    listEl.innerHTML = "";
    if (!names.length) {
      const e = document.createElement("div");
      e.className = "outline-empty";
      e.textContent = t("（暂无已保存的宏）");
      listEl.appendChild(e);
      return;
    }
    for (const n of names) {
      const row = document.createElement("div");
      row.className = "rec-item";
      row.innerHTML = `<span class="rec-name">${escapeHtml(n)}</span><span class="rec-btns"><button class="search-btn" data-play>${t("播放")}</button><button class="search-btn" data-del>${t("删除")}</button></span>`;
      row.querySelector("[data-play]")!.addEventListener("click", (_e) => {
        _e.stopPropagation();
        loadMacroFromStore(view, n);
        runMacro(view);
        view.focus();
        onToast(t("已播放宏「{n}」", { n }));
      });
      row.querySelector("[data-del]")!.addEventListener("click", (_e) => {
        _e.stopPropagation();
        deleteStoredMacro(n);
        render();
      });
      listEl.appendChild(row);
    }
  };

  modal.querySelector("#mac-save")!.addEventListener("click", () => {
    const name = (modal.querySelector("#mac-name") as HTMLInputElement).value.trim();
    if (!name) {
      onToast(t("请输入宏名称"));
      return;
    }
    if (saveMacroToStore(view, name)) {
      onToast(t("已保存宏「{name}」", { name }));
      (modal.querySelector("#mac-name") as HTMLInputElement).value = "";
      render();
    } else {
      onToast(t("当前宏为空，无法保存"));
    }
  });
  modal.querySelector("#mac-export")!.addEventListener("click", () => {
    const macros: Record<string, MacroStep[]> = {};
    for (const n of listStoredMacros()) {
      const raw = localStorage.getItem(PREFIX + n);
      if (raw) {
        try {
          macros[n] = JSON.parse(raw) as MacroStep[];
        } catch {
          /* skip malformed entry */
        }
      }
    }
    const blob = new Blob([JSON.stringify({ version: 1, macros }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "uec-macros.json";
    a.click();
    URL.revokeObjectURL(url);
    onToast(t("已导出 {n} 个宏", { n: Object.keys(macros).length }));
  });

  const importFile = modal.querySelector<HTMLInputElement>("#mac-import-file")!;
  modal.querySelector("#mac-import")!.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || typeof data.macros !== "object") {
        onToast(t("宏文件格式无效"));
        return;
      }
      let count = 0;
      for (const [name, steps] of Object.entries(data.macros)) {
        if (Array.isArray(steps) && storeMacroSteps(name, steps as MacroStep[])) count++;
      }
      onToast(t("已导入 {n} 个宏", { n: count }));
      render();
    } catch (e) {
      onToast(t("导入失败：{e}", { e: String(e) }));
    }
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