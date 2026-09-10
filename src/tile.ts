// 多标签平铺：每个标签一个独立编辑器格子（SecureCRT Tile 风格）
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { MarkdownPreview } from "./markdown-preview";
import { t } from "./i18n";

export interface TileDocLike {
  id: string;
  name: string;
  path?: string;
  mode: "text" | "hex";
  dirty?: boolean;
  state?: EditorState | null;
  scrollTop?: number | null;
}

// 一个格子：标题条（即平铺模式下的标签）+ 独立 CodeMirror + 可选格内 Markdown 预览
export class TileCell {
  readonly id: string;
  el: HTMLElement;
  view: EditorView;
  previewWrap: HTMLElement;
  private doc: TileDocLike;
  private headTitle: HTMLElement;
  private headDot: HTMLElement;
  private preview: MarkdownPreview | null = null;
  private previewOn = false;
  private refreshTimer: number | null = null;
  private onActivate: (id: string) => void;
  private onClose: (id: string) => void;
  private onMenu: (x: number, y: number, doc: TileDocLike) => void;
  get previewVisible(): boolean {
    return this.previewOn;
  }

  constructor(
    doc: TileDocLike,
    onActivate: (id: string) => void,
    onClose: (id: string) => void,
    onMenu: (x: number, y: number, doc: TileDocLike) => void,
  ) {
    this.id = doc.id;
    this.doc = doc;
    this.onActivate = onActivate;
    this.onClose = onClose;
    this.onMenu = onMenu;
    this.el = document.createElement("div");
    this.el.className = "tile-cell";
    this.el.innerHTML =
      `<div class="tile-head"><span class="tile-dot">●</span><span class="tile-title"></span>` +
      `<button class="tile-close" title="${t("关闭标签")}">✕</button></div>` +
      `<div class="tile-content"><div class="tile-body"></div>` +
      `<div class="tile-preview hidden"></div></div>`;
    this.headTitle = this.el.querySelector(".tile-title")!;
    this.headDot = this.el.querySelector(".tile-dot")!;
    this.headDot.style.opacity = doc.dirty ? "1" : "0";
    this.headTitle.textContent = doc.name;
    this.headTitle.title = doc.path || doc.name;
    const body = this.el.querySelector<HTMLElement>(".tile-body")!;
    this.previewWrap = this.el.querySelector(".tile-preview")!;
    this.el.querySelector(".tile-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onClose(this.id);
    });
    this.el.querySelector(".tile-head")!.addEventListener("contextmenu", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const me = e as MouseEvent;
      this.onMenu(me.clientX, me.clientY, this.doc);
    });
    // 点击格子先激活，编辑器再接管键盘
    this.el.addEventListener("pointerdown", () => this.onActivate(this.id));
    this.view = new EditorView({
      parent: body,
      state: doc.state ?? EditorState.create({ doc: "", extensions: [] }),
    });
    // 键盘焦点进入格子（Tab/点击已有焦点编辑器）也激活该格
    this.view.dom.addEventListener("focusin", () => this.onActivate(this.id));
    if (doc.scrollTop != null) this.view.scrollDOM.scrollTop = doc.scrollTop;
  }

  setDirty(on: boolean) {
    this.headDot.style.opacity = on ? "1" : "0";
  }

  // 格内 Markdown 预览开关（每格独立实例）
  togglePreview() {
    if (this.previewOn) {
      this.preview?.destroy();
      this.preview = null;
      this.previewOn = false;
      this.previewWrap.classList.add("hidden");
      return;
    }
    this.previewWrap.classList.remove("hidden");
    this.preview = new MarkdownPreview(this.previewWrap);
    this.preview.attach(this.view);
    this.previewOn = true;
    this.refreshPreview();
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refreshPreview(), 150);
  }

  refreshPreview() {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!this.previewOn || !this.preview) return;
    const st = this.view.state;
    this.preview.show(st.doc.toString());
    const head = st.selection.main.head;
    this.preview.syncCursor(st.doc.lineAt(head).number, st.doc.lines);
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.preview?.destroy();
    this.preview = null;
    try {
      this.view.destroy();
    } catch {
      /* ignore */
    }
    this.el.remove();
  }
}

// 终端格子：标题条 + xterm 容器（平铺模式下 SSH 会话保持可用）
export class TerminalTileCell {
  readonly id: string;
  el: HTMLElement;
  body: HTMLElement;
  private headTitle: HTMLElement;
  private onActivate: (id: string) => void;
  private onClose: (id: string) => void;
  private onMenu: (x: number, y: number) => void;

  constructor(
    id: string,
    title: string,
    termEl: HTMLElement,
    onActivate: (id: string) => void,
    onClose: (id: string) => void,
    onMenu: (x: number, y: number) => void,
  ) {
    this.id = id;
    this.onActivate = onActivate;
    this.onClose = onClose;
    this.onMenu = onMenu;
    this.el = document.createElement("div");
    this.el.className = "tile-cell term-tile-cell";
    this.el.innerHTML =
      `<div class="tile-head"><span class="tile-dot">●</span><span class="tile-title"></span>` +
      `<button class="tile-close" title="${t("关闭标签")}">✕</button></div>` +
      `<div class="tile-content"><div class="tile-body term-tile-body"></div></div>`;
    this.headTitle = this.el.querySelector(".tile-title")!;
    this.headTitle.textContent = title;
    this.headTitle.title = title;
    this.body = this.el.querySelector(".tile-body")!;
    // term.el 从终端区域迁入（display 重置为块级，ResizeObserver 会自动触发 fit）
    termEl.style.display = "";
    this.body.appendChild(termEl);
    this.el.querySelector(".tile-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onClose(this.id);
    });
    this.el.querySelector(".tile-head")!.addEventListener("contextmenu", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const me = e as MouseEvent;
      this.onMenu(me.clientX, me.clientY);
    });
    // 点击格子即激活该终端
    this.el.addEventListener("pointerdown", () => this.onActivate(this.id));
  }

  setTitle(title: string) {
    this.headTitle.textContent = title;
    this.headTitle.title = title;
  }

  destroy() {
    this.el.remove();
  }
}
