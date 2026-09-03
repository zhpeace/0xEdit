import { t } from "./i18n";

const STORAGE_KEY = "uec.script";

export function showScriptDialog() {
  let script = "";
  try {
    script = localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    script = "";
  }

  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal script-modal">
      <div class="modal-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${t("脚本编辑器")}</span>
        <div style="display:flex;gap:6px;">
          <button class="search-btn" data-run style="background:var(--accent);color:#fff;border-color:var(--accent);">${t("运行")}</button>
          <button class="search-btn" data-close>${t("关闭")}</button>
        </div>
      </div>
      <textarea class="script-editor" spellcheck="false" placeholder="${t("脚本编辑器占位")}"></textarea>
      <div class="script-output" data-output></div>
    </div>`;
  document.body.appendChild(modal);

  const editor = modal.querySelector<HTMLTextAreaElement>(".script-editor")!;
  const output = modal.querySelector<HTMLElement>("[data-output]")!;
  editor.value = script;

  const run = () => {
    const code = editor.value;
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      /* ignore */
    }
    const logs: string[] = [];
    const origLog = console.log;
    const origInfo = console.info;
    console.log = (...args: unknown[]) => logs.push(args.map((a) => fmt(a)).join(" "));
    console.info = (...args: unknown[]) => logs.push(args.map((a) => fmt(a)).join(" "));
    try {
      const fn = new Function(code);
      const result = fn();
      if (result !== undefined) logs.push(t("返回值: ") + fmt(result));
    } catch (e) {
      logs.push(t("错误: ") + (e as Error).message);
    } finally {
      console.log = origLog;
      console.info = origInfo;
    }
    output.textContent = logs.length ? logs.join("\n") : t("(无输出)");
  };

  modal.querySelector("[data-run]")!.addEventListener("click", run);
  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      run();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
    }
  });

  editor.focus();
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}