import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

interface SearchItem {
  path: string;
  line: number;
  content: string;
  index: number;
}

interface SearchResult {
  items: SearchItem[];
  files: number;
  truncated: boolean;
}

export class FileSearch {
  private onOpen: (path: string, line: number) => void;
  private onPersist: (items: SearchItem[]) => void;
  private modal: HTMLElement | null = null;

  constructor(onOpen: (path: string, line: number) => void, onPersist: (items: SearchItem[]) => void) {
    this.onOpen = onOpen;
    this.onPersist = onPersist;
  }

  open(defaultDir: string, replaceMode: boolean) {
    this.close();
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `
      <div class="modal filesearch">
        <div class="modal-title">${t(replaceMode ? "在文件中替换" : "在文件中查找")}</div>
        <div class="fs-row">
          <input id="fs-dir" class="fs-input" placeholder="${t("目录...")}" spellcheck="false" value="${escapeAttr(defaultDir)}"/>
          <button class="search-btn" id="fs-browse">${t("浏览…")}</button>
        </div>
        <div class="fs-row">
          <input id="fs-query" class="fs-input" placeholder="${t("查找内容...")}" spellcheck="false"/>
          ${replaceMode ? `<input id="fs-replace" class="fs-input" placeholder="${t("替换为...")}" spellcheck="false"/>` : ""}
        </div>
        <div class="fs-options">
          <label class="search-opt"><input type="checkbox" id="fs-case"/>${t("区分大小写")}</label>
          <label class="search-opt"><input type="checkbox" id="fs-regex"/>${t("正则")}</label>
          <label class="search-opt"><input type="checkbox" id="fs-word"/>${t("全词")}</label>
          <button class="search-btn" id="fs-run">${t("搜索")}</button>
          ${replaceMode ? `<button class="search-btn" id="fs-replace-all">${t("替换所有")}</button>` : ""}
          <button class="search-btn fs-close" id="fs-close">${t("关闭")}</button>
        </div>
        <div id="fs-results" class="fs-results"><div class="fs-empty">${t("输入查找内容并点击搜索")}</div></div>
        <div id="fs-status" class="fs-status"></div>
      </div>`;
    document.body.appendChild(modal);
    this.modal = modal;

    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      if (e.key === "Enter" && (e.target as HTMLElement).id === "fs-query") this.run(replaceMode);
    });

    modal.querySelector("#fs-browse")!.addEventListener("click", async () => {
      const picked = await dialogOpen({ directory: true, multiple: false, title: t("选择目录") });
      if (picked) {
        (modal.querySelector("#fs-dir") as HTMLInputElement).value = picked;
      }
    });
    modal.querySelector("#fs-run")!.addEventListener("click", () => this.run(replaceMode));
    modal.querySelector("#fs-close")!.addEventListener("click", () => this.close());
    modal.querySelector("#fs-replace-all")?.addEventListener("click", () => this.replaceAll());

    modal.querySelector("#fs-results")!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-file]");
      if (!el) return;
      const path = el.dataset.file!;
      const line = parseInt(el.dataset.line || "1", 10);
      this.close();
      this.onOpen(path, line);
    });

    (modal.querySelector("#fs-query") as HTMLInputElement).focus();
  }

  private run(replaceMode: boolean) {
    const modal = this.modal;
    if (!modal) return;
    const dir = (modal.querySelector("#fs-dir") as HTMLInputElement).value.trim();
    const query = (modal.querySelector("#fs-query") as HTMLInputElement).value;
    const caseSensitive = (modal.querySelector("#fs-case") as HTMLInputElement).checked;
    const regex = (modal.querySelector("#fs-regex") as HTMLInputElement).checked;
    const wholeWord = (modal.querySelector("#fs-word") as HTMLInputElement).checked;
    const status = modal.querySelector("#fs-status")!;
    const results = modal.querySelector("#fs-results")!;
    if (!dir || !query) {
      status.textContent = t("请填写目录和查找内容");
      return;
    }
    status.textContent = t("搜索中…");
    invoke<SearchResult>("search_in_dir", { dir, query, caseSensitive, regex, whole_word: wholeWord })
      .then((res) => {
        status.textContent = t("在 {files} 个文件找到 {items} 处", { files: res.files, items: res.items.length }) + (res.truncated ? t("（结果过多已截断）") : "");
        results.innerHTML = "";
        if (!res.items.length) {
          results.innerHTML = `<div class="fs-empty">${t("没有匹配")}</div>`;
          return;
        }
        const frag = document.createDocumentFragment();
        let lastFile = "";
        for (const item of res.items) {
          const file = item.path;
          if (file !== lastFile) {
            lastFile = file;
            const head = document.createElement("div");
            head.className = "fs-file";
            head.textContent = file;
            frag.appendChild(head);
          }
          const row = document.createElement("div");
          row.className = "fs-item";
          row.dataset.file = file;
          row.dataset.line = String(item.line);
          row.innerHTML = `<span class="fs-line-no">${item.line}</span><span class="fs-line-text">${escapeHtml(item.content)}</span>`;
          frag.appendChild(row);
        }
        results.appendChild(frag);
        this.onPersist(res.items);
        if (replaceMode) {
          this.enableReplace();
        }
      })
      .catch((e) => {
        status.textContent = t("搜索失败：") + e;
      });
  }

  private enableReplace() {
    const modal = this.modal;
    if (!modal) return;
    const btn = modal.querySelector<HTMLButtonElement>("#fs-replace-all");
    if (btn) btn.classList.remove("hidden");
  }

  private async replaceAll() {
    const modal = this.modal;
    if (!modal) return;
    const dir = (modal.querySelector("#fs-dir") as HTMLInputElement).value.trim();
    const query = (modal.querySelector("#fs-query") as HTMLInputElement).value;
    const replacement = (modal.querySelector("#fs-replace") as HTMLInputElement)?.value ?? "";
    const caseSensitive = (modal.querySelector("#fs-case") as HTMLInputElement).checked;
    const regex = (modal.querySelector("#fs-regex") as HTMLInputElement).checked;
    const wholeWord = (modal.querySelector("#fs-word") as HTMLInputElement).checked;
    if (!window.confirm(t("确定要在目录 “{dir}” 下将所有匹配替换为？", { dir }) + ` “${replacement}”`)) return;
    const status = modal.querySelector("#fs-status")!;
    status.textContent = t("替换中…");
    try {
      const res = await invoke<{ replaced: number; failed: string[] }>("replace_in_dir", {
        dir,
        query,
        replacement,
        caseSensitive,
        regex,
        whole_word: wholeWord,
      });
      status.textContent = t("已替换 {n} 个文件", { n: res.replaced }) + (res.failed.length ? t("，失败 {m} 个", { m: res.failed.length }) : "");
      this.run(false);
    } catch (e) {
      status.textContent = t("替换失败：") + e;
    }
  }

  close() {
    this.modal?.remove();
    this.modal = null;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}