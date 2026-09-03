import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

interface BigPage {
  text: string;
  start: number;
  done: boolean;
  truncated_at: number;
}

export class BigViewer {
  private path: string;
  private total = 0;
  private offset = 0;
  private currentText = "";
  private modal: HTMLElement | null = null;
  private editing = false;

  constructor(path: string) {
    this.path = path;
  }

  async open() {
    this.total = await invoke<number>("file_size", { path: this.path }).catch(() => 0);
    await this.load(this.offset);
  }

  private async load(offset: number) {
    const page = await invoke<BigPage>("text_page", { path: this.path, offset, maxLen: 2 * 1024 * 1024 });
    this.offset = page.start;
    this.currentText = page.text;
    this.render();
  }

  private render() {
    const off = this.offset;
    const end = Math.min(off + new Blob([this.currentText]).size, this.total);
    this.modal!.querySelector<HTMLElement>("#bv-offset")!.textContent = `${t("偏移")} ${off} – ${end} / ${this.total} ${t("字节")} (${this.currentText.split("\n").length} ${t("行")})`;
    this.modal!.querySelector<HTMLTextAreaElement>("#bv-area")!.value = this.currentText;
  }

  show() {
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `
      <div class="modal bigview">
        <div class="modal-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span class="bv-name">${t("大文件查看 / 编辑")}</span>
          <span id="bv-offset" style="font-family:var(--mono);font-size:11px;color:var(--fg-dim);"></span>
        </div>
        <div class="bv-status" style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
          <button class="search-btn" id="bv-prev">${t("上一页")}</button>
          <button class="search-btn" id="bv-next">${t("下一页")}</button>
          <button class="search-btn" id="bv-goto">${t("跳转偏移…")}</button>
          <button class="search-btn" id="bv-edit">${this.editing ? t("退出编辑") : t("编辑本页")}</button>
          <button class="search-btn" id="bv-save" ${this.editing ? "" : "disabled"} style="${this.editing ? "" : "opacity:.5"}">${t("写回本页")}</button>
        </div>
        <textarea id="bv-area" class="script-editor bigview-area" readonly spellcheck="false"></textarea>
        <div class="modal-actions" style="margin-top:8px;"><button class="primary" data-close>${t("关闭")}</button></div>
      </div>`;
    document.body.appendChild(modal);
    this.modal = modal;

    const areaHost = () => modal.querySelector<HTMLTextAreaElement>("#bv-area")!;
    const setEdit = (on: boolean) => {
      this.editing = on;
      const btn = modal.querySelector<HTMLButtonElement>("#bv-edit")!;
      const save = modal.querySelector<HTMLButtonElement>("#bv-save")!;
      btn.textContent = on ? t("退出编辑") : t("编辑本页");
      save.disabled = !on;
      save.style.opacity = on ? "" : ".5";
      try {
        areaHost().readOnly = !on;
      } catch { /* ignore */ }
    };

    modal.querySelector("#bv-prev")!.addEventListener("click", async () => {
      if (this.offset <= 0) return;
      if (this.editing) return;
      await this.load(Math.max(0, this.offset - 2 * 1024 * 1024));
    });
    modal.querySelector("#bv-next")!.addEventListener("click", async () => {
      if (this.currentText.length === 0 || this.offset + new Blob([this.currentText]).size >= this.total) return;
      if (this.editing) return;
      await this.load(this.offset + new Blob([this.currentText]).size);
    });
    modal.querySelector("#bv-goto")!.addEventListener("click", () => {
      const v = prompt(t("跳转到偏移量（字节）:"));
      if (!v) return;
      const off = parseInt(v, 10);
      if (Number.isNaN(off)) return;
      void this.load(Math.max(0, Math.min(off, Math.max(0, this.total - 1))));
    });
    modal.querySelector("#bv-edit")!.addEventListener("click", () => setEdit(!this.editing));
    modal.querySelector("#bv-save")!.addEventListener("click", async () => {
      const newText = areaHost().value;
      try {
        await invoke("text_write", { path: this.path, offset: this.offset, text: newText });
        this.currentText = newText;
        setEdit(false);
        this.render();
      } catch (e) {
        this.render();
        window.alert(t("写回失败：") + e);
      }
    });
    modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.remove();
    });

    this.render();
  }
}

export async function showBigViewer(path: string) {
  const v = new BigViewer(path);
  await v.open();
  v.show();
}