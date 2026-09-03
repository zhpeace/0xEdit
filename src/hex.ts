import { invoke } from "@tauri-apps/api/core";
import type { Document } from "./types";
import { t } from "./i18n";

const ROW = 16;

export class HexEditor {
  private data: Uint8Array = new Uint8Array(0);
  private dirty = new Set<number>();
  private structural = false;
  private loaded = false;
  private container: HTMLElement;
  private body: HTMLElement;
  private rowsEl: HTMLElement;
  private statusEl: HTMLElement;
  private goEl: HTMLInputElement;
  private insertBtn: HTMLButtonElement;
  private path = "";
  private cursor = 0;
  private anchor = 0;
  private focused = false;
  private hexInsertMode = false;
  private pending = new Map<number, number>();
  private onDirty: (dirty: boolean) => void;

  constructor(
    root: HTMLElement,
    onDirty: (dirty: boolean) => void,
  ) {
    this.onDirty = onDirty;
    root.innerHTML = `
      <div class="hex-toolbar">
        <span class="hex-label">${t("十六进制")}</span>
        <button class="hex-btn" data-act="goto">${t("定位")}</button>
        <input class="hex-go" placeholder="${t("偏移量 (十进制/0x)")}" spellcheck="false"/>
        <span class="hex-spacer"></span>
        <button class="hex-btn" data-act="insbyte">${t("插入字节")}</button>
        <button class="hex-btn" data-act="delbyte">${t("删除字节")}</button>
        <button class="hex-btn hex-insert" data-act="toggle-insert">${t("覆盖模式")}</button>
        <span class="hex-info"></span>
      </div>
      <div class="hex-body"><div class="hex-rows"></div></div>`;

    this.container = root;
    this.body = root.querySelector<HTMLElement>(".hex-body")!;
    this.rowsEl = root.querySelector<HTMLElement>(".hex-rows")!;
    this.statusEl = root.querySelector<HTMLElement>(".hex-info")!;
    this.goEl = root.querySelector<HTMLInputElement>(".hex-go")!;
    this.insertBtn = root.querySelector<HTMLButtonElement>(".hex-insert")!;

    this.body.addEventListener("scroll", () => this.render());
    this.rowsEl.addEventListener("mousedown", (e) => this.onMouseDown(e));

    const toolbar = root.querySelector<HTMLElement>(".hex-toolbar")!;
    toolbar.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "goto") this.goto();
      if (act === "insbyte") this.insertByte();
      if (act === "delbyte") this.deleteByte();
      if (act === "toggle-insert") this.toggleInsertMode();
    });
    this.goEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.goto();
    });
    window.addEventListener("keydown", (e) => {
      if (this.focused && this.container.closest(".hidden") === null) this.onKey(e);
    });
  }

  async open(doc: Document) {
    this.path = doc.path;
    this.data = new Uint8Array(0);
    this.dirty.clear();
    this.structural = false;
    this.pending.clear();
    this.loaded = false;
    this.cursor = 0;
    this.anchor = 0;
    this.renderInfo();
    this.render();

    if (doc.hexBytes && doc.hexBytes.length) {
      this.data = doc.hexBytes;
      this.loaded = true;
      this.render();
      return;
    }

    const size = await invoke<number>("file_size", { path: this.path }).catch(() => 0);
    if (size > 512 * 1024 * 1024) {
      this.statusEl.textContent = t("文件过大(>512MB)，仅能覆盖编辑前 512MB");
    }
    const limit = Math.min(size, 512 * 1024 * 1024);
    this.data = new Uint8Array(limit);
    let offset = 0;
    const chunk = 4 * 1024 * 1024;
    try {
      while (offset < limit) {
        const len = Math.min(chunk, limit - offset);
        const part = await invoke<number[]>("read_hex_range", {
          path: this.path,
          offset,
          length: len,
        });
        this.data.set(Uint8Array.from(part), offset);
        offset += len;
      }
      this.loaded = true;
    } catch {
      this.loaded = false;
      this.statusEl.textContent = t("读取失败");
    }
    doc.hexBytes = this.data;
    this.renderInfo();
    this.render();
  }

  get size(): number {
    return this.data.length;
  }

  isDirty(): boolean {
    return this.dirty.size > 0 || this.structural;
  }

  private renderInfo() {
    const mem = this.data.length;
    this.statusEl.textContent = `${mem} ${t("字节")} / ${this.loaded ? t("已加载") : t("加载中")} / ${this.hexInsertMode ? t("插入模式") : t("覆盖模式")} · ${this.dirty.size} ${t("处修改")}`;
  }

  private toggleInsertMode() {
    this.hexInsertMode = !this.hexInsertMode;
    this.insertBtn.textContent = this.hexInsertMode ? t("插入模式") : t("覆盖模式");
    this.insertBtn.classList.toggle("active", this.hexInsertMode);
    this.renderInfo();
  }

  private goto() {
    const v = this.goEl.value.trim();
    let off = parseInt(v, 16);
    if (!/^0x/i.test(v) && v.startsWith("0")) off = parseInt(v, 16);
    if (Number.isNaN(off)) off = parseInt(v, 10);
    if (Number.isNaN(off)) return;
    this.cursor = Math.max(0, Math.min(this.data.length - 1, off));
    this.anchor = this.cursor;
    this.ensureVisible();
    this.render();
  }

  private ensureVisible() {
    const row = Math.floor(this.cursor / ROW);
    const rowH = 20;
    this.body.scrollTop = row * rowH;
  }

  private onMouseDown(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!t) return;
    const off = parseInt(t.dataset.cell || "0", 10);
    this.anchor = off;
    this.cursor = off;
    this.clearPending();
    this.focused = true;
    this.updateCells();
    e.preventDefault();
    if (this.onCursorCb) this.onCursorCb(off);
  }

  onCursorCb: ((o: number) => void) | null = null;

  private onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey) return;
    const cell = Math.floor(this.cursor / ROW) * ROW + (this.cursor % ROW);
    let handled = true;
    const byteLen = this.data.length;
    switch (e.key) {
      case "ArrowLeft":
        if (this.cursor > 0) this.moveTo(this.cursor - 1);
        break;
      case "ArrowRight":
        if (this.cursor < byteLen - 1) this.moveTo(this.cursor + 1);
        break;
      case "ArrowUp":
        if (this.cursor - ROW >= 0) this.moveTo(this.cursor - ROW);
        break;
      case "ArrowDown":
        if (this.cursor + ROW < byteLen) this.moveTo(this.cursor + ROW);
        break;
      case "Home":
        this.moveTo(cell);
        break;
      case "End":
        this.moveTo(Math.min(cell + ROW - 1, byteLen - 1));
        break;
      case "PageUp":
        this.moveTo(Math.max(0, this.cursor - ROW * 20));
        break;
      case "PageDown":
        this.moveTo(Math.min(byteLen - 1, this.cursor + ROW * 20));
        break;
      case "Backspace":
      case "Delete": {
        if (this.anchor !== this.cursor) {
          const from = Math.min(this.anchor, this.cursor);
          const to = Math.max(this.anchor, this.cursor);
          this.eraseRange(from, to + 1);
        } else if (e.key === "Delete" && this.cursor < byteLen) {
          this.eraseRange(this.cursor, this.cursor + 1);
        } else if (e.key === "Backspace" && this.cursor > 0) {
          this.eraseRange(this.cursor - 1, this.cursor);
          this.moveTo(this.cursor - 1);
        }
        break;
      }
      case "Shift":
        handled = false;
        break;
      default: {
        if (e.key.length === 1 && /[0-9a-fA-F]/.test(e.key)) {
          this.enterHexDigit(e.key);
        } else if (e.key.length === 1 && e.key.charCodeAt(0) >= 0x20 && e.key.charCodeAt(0) < 0x7f) {
          this.enterAscii(e.key.charCodeAt(0));
        } else {
          handled = false;
        }
      }
    }
    if (handled) e.preventDefault();
  }

  private moveTo(off: number) {
    this.cursor = off;
    this.anchor = off;
    this.clearPending();
    this.ensureVisible();
    this.render();
    if (this.onCursorCb) this.onCursorCb(off);
  }

  private shiftCursorInSelection() {
    if (this.anchor !== this.cursor) {
      const dir = this.cursor > this.anchor ? 1 : -1;
      const from = Math.min(this.anchor, this.cursor);
      const to = Math.max(this.anchor, this.cursor);
      if (dir > 0) this.anchor = to - ROW;
      else this.anchor = from + ROW;
    }
  }

  private enterHexDigit(digit: string) {
    if (this.cursor >= this.data.length) return;
    const cur = this.cursor;
    if (this.pending.has(cur)) {
      const hi = this.pending.get(cur)!;
      this.pending.delete(cur);
      this.setByte(cur, hi + parseInt(digit, 16));
      this.moveTo(Math.min(this.data.length - 1, cur + 1));
    } else {
      this.pending.set(cur, parseInt(digit, 16) * 16);
    }
    this.render();
  }

  private clearPending() {
    this.pending.clear();
  }

  private enterAscii(code: number) {
    if (this.cursor >= this.data.length) return;
    this.setByte(this.cursor, code);
    this.shiftCursorInSelection();
    this.moveTo(this.cursor);
    this.render();
  }

  private setByte(off: number, value: number) {
    if (this.data[off] === value) return;
    this.data[off] = value;
    this.dirty.add(off);
    this.renderInfo();
    if (this.onDirty) this.onDirty(true);
  }

  private eraseRange(from: number, to: number) {
    if (this.hexInsertMode) {
      const removed = Array.from(this.data.slice(from, to));
      const rest = Array.from(this.data.slice(to));
      this.data = Uint8Array.from([...Array.from(this.data.slice(0, from)), ...rest]);
      removed.forEach((_b, i) => this.dirty.add(from + i));
      this.structural = true;
      this.cursor = Math.min(from, this.data.length - 1);
      this.anchor = this.cursor;
      this.dirty.forEach(() => {});
      this.renderInfo();
      this.render();
      if (this.onDirty) this.onDirty(true);
    } else {
      for (let i = from; i < to && i < this.data.length; i++) {
        if (this.data[i] !== 0) {
          this.data[i] = 0;
          this.dirty.add(i);
        }
      }
      this.anchor = this.cursor;
      this.renderInfo();
      this.render();
      if (this.onDirty) this.onDirty(true);
    }
  }

  private insertByte() {
    if (this.cursor >= this.data.length) return;
    const rest = Array.from(this.data.slice(this.cursor));
    this.data = Uint8Array.from([...Array.from(this.data.slice(0, this.cursor)), 0, ...rest]);
    this.structural = true;
    this.dirty.add(this.cursor);
    this.renderInfo();
    this.render();
    if (this.onDirty) this.onDirty(true);
  }

  private deleteByte() {
    if (this.cursor >= this.data.length) return;
    this.eraseRange(this.cursor, this.cursor + 1);
  }

  private updateCells() {
    this.rowsEl.querySelectorAll("[data-cell]").forEach((el) => {
      const off = parseInt((el as HTMLElement).dataset.cell || "0", 10);
      const sel = off >= Math.min(this.anchor, this.cursor) && off <= Math.max(this.anchor, this.cursor);
      el.classList.toggle("hex-sel", sel);
    });
  }

  private render() {
    if (!this.loaded) return;
    const totalRows = Math.max(1, Math.ceil(this.data.length / ROW));
    const rowH = 20;
    const viewH = this.body.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.body.scrollTop / rowH) - 10);
    const last = Math.min(totalRows - 1, Math.ceil((this.body.scrollTop + viewH) / rowH) + 10);
    this.rowsEl.style.height = `${totalRows * rowH}px`;
    this.rowsEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    const selFrom = Math.min(this.anchor, this.cursor);
    const selTo = Math.max(this.anchor, this.cursor);
    for (let r = first; r <= last; r++) {
      const row = document.createElement("div");
      row.className = "hex-row";
      row.style.transform = `translateY(${r * rowH}px)`;
      const offsetSpan = document.createElement("span");
      offsetSpan.className = "hex-offset";
      offsetSpan.textContent = r.toString(16).padStart(8, "0");
      row.appendChild(offsetSpan);
      const start = r * ROW;
      for (let i = 0; i < ROW; i++) {
        const off = start + i;
        if (off >= this.data.length) {
          row.appendChild(this.emptyCell());
          continue;
        }
        const cell = document.createElement("span");
        cell.className = "hex-cell";
        cell.dataset.cell = String(off);
        const pendingVal = this.pending.get(off);
        if (pendingVal !== undefined) {
          cell.textContent = (pendingVal >> 4).toString(16).toUpperCase() + "_";
          cell.classList.add("hex-pending");
        } else {
          cell.textContent = this.data[off].toString(16).padStart(2, "0").toUpperCase();
        }
        cell.style.color = this.dirty.has(off) ? "var(--hex-changed)" : "var(--hex-cell)";
        if (off >= selFrom && off <= selTo) cell.classList.add("hex-sel");
        row.appendChild(cell);
        if (i % 8 === 7) row.appendChild(document.createElement("span")).className = "hex-gap";
      }
      const ascii = document.createElement("span");
      ascii.className = "hex-ascii";
      let s = "";
      for (let i = 0; i < ROW; i++) {
        const off = start + i;
        if (off >= this.data.length) break;
        const b = this.data[off];
        s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
      }
      ascii.textContent = s;
      row.appendChild(ascii);
      frag.appendChild(row);
    }
    this.rowsEl.appendChild(frag);
  }

  private emptyCell(): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "hex-cell hex-empty";
    cell.textContent = "  ";
    return cell;
  }

  async save(): Promise<boolean> {
    if (!this.loaded) return false;
    if (!this.structural) {
      const offsets = Array.from(this.dirty).sort((a, b) => a - b);
      const batches: Array<[number, Uint8Array]> = [];
      for (const off of offsets) {
        if (batches.length && batches[batches.length - 1][0] + batches[batches.length - 1][1].length === off) {
          const b = batches[batches.length - 1][1];
          const nb = new Uint8Array(b.length + 1);
          nb.set(b);
          nb[b.length] = this.data[off];
          batches[batches.length - 1][1] = nb;
        } else {
          batches.push([off, new Uint8Array([this.data[off]])]);
        }
      }
      for (const [off, bytes] of batches) {
        await invoke("write_hex_range", { path: this.path, offset: off, data: Array.from(bytes) });
      }
    } else {
      await invoke("write_hex_range", {
        path: this.path,
        offset: 0,
        data: Array.from(this.data),
      });
    }
    this.dirty.clear();
    this.structural = false;
    this.renderInfo();
    return true;
  }

  getBytes(): Uint8Array {
    return this.data;
  }

  getCursor(): number {
    return this.cursor;
  }

  focus() {
    this.focused = true;
  }

  blur() {
    this.focused = false;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}