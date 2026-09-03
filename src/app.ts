import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, highlightWhitespace } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  defaultKeymap, historyKeymap, history, undo, redo, insertTab, insertNewlineAndIndent, indentMore, indentLess,
  copyLineDown, deleteLine, moveLineUp, moveLineDown, toggleComment, addCursorAbove, addCursorBelow,
} from "@codemirror/commands";
import { defaultHighlightStyle, bracketMatching, syntaxHighlighting, indentOnInput, foldGutter, foldKeymap } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, findNext, findPrevious, selectMatches, RegExpCursor } from "@codemirror/search";
import type { Document } from "./types";
import { langForPath } from "./langs";
import { rectangleSelection, setColumnMode, isColumnMode } from "./rect";
import { HexEditor, formatSize } from "./hex";
import { FindBar, searchHighlight } from "./find";
import { FileTree } from "./filetree";
import { bookmarks, toggleBookmark, nextBookmark, prevBookmark, clearAllBookmarks } from "./bookmarks";
import { editPositionListener, jumpBack, jumpForward } from "./jumplist";
import { sortSelection, titleCaseSelection, joinLines, upperCaseCmd, lowerCaseCmd, toggleCaseCmd, insertNumberSequence, convertLineEndings, lineEndingLabel, rewrapLines, type LineEnding } from "./editops";
import { getRecent, addRecent, clearRecent } from "./recent";
import { FileSearch } from "./filesearch";
import { CommandPalette, type CommandEntry } from "./palette";
import { macroExtension, toggleRecordMacro, clearMacro, runMacro, macroManagerDialog } from "./macro";
import { showDiffDialog, type DiffDocRef } from "./diff";
import { showScriptDialog } from "./script";
import { MarkdownPreview, isMarkdownDoc, renderMarkdown } from "./markdown-preview";
import { textConvertDialog } from "./convert";
import { showDirCompare } from "./dircmp";
import { clipListener, openClipHistory } from "./cliphist";
import { showBigViewer } from "./bigview";
import { snippetCompletionSource, snippetManagerDialog } from "./snippets";
import { spellCheckDialog } from "./spellcheck";
import { kwSourceFor } from "./kwcomplete";
import { RemoteBrowser } from "./remote";
import { Outline } from "./outline";
import { t, setLang, getLang, onLangChange } from "./i18n";
import {
  formatJson, minifyJson, formatHtml, formatXml, base64Encode, base64Decode, urlEncode, urlDecode,
  indentToSpaces, indentToTabs, countText, type ToolResult,
} from "./tools";

// Some WebKit builds (e.g. Tauri's WKWebView) scroll the editor's scroll
// container to the top when a contenteditable inside it receives focus from a
// pointer interaction, even though the clicked position is already visible.
// This guard restores the previous scroll position if such an erroneous jump
// occurs. It never interferes with legitimate scrolls because clicking inside
// the visible viewport should not move the scroll container by more than 1000px.
const webkitFocusScrollGuard = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target as HTMLElement | null;
    if (t && t.closest(".cm-content")) {
      (view as unknown as { __scrollAtDown?: number }).__scrollAtDown = view.scrollDOM.scrollTop;
    }
  },
  focus(_e, view) {
    const rec = view as unknown as { __scrollAtDown?: number };
    const before = rec.__scrollAtDown;
    if (before == null) return;
    rec.__scrollAtDown = undefined;
    requestAnimationFrame(() => {
      const s = view.scrollDOM;
      if (s && before > 50 && s.scrollTop < before - 1000) {
        s.scrollTop = before;
      }
    });
  },
});

const wrapCompartment = new Compartment();
const wsCompartment = new Compartment();
const langCompartment = new Compartment();

const uid = () => Math.random().toString(36).slice(2, 10);

const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function decodeUint8(buf: Uint8Array, hint: string): string {
  let enc = hint || "utf-8";
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function detectBrowseEncoding(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  return "utf-8";
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const MOD_SYM = isMac ? "⌘" : "Ctrl";
const ALT_SYM = isMac ? "⌥" : "Alt";

// 把菜单里写死的 ⌘/⇧/⌥ 提示按当前平台转换成正确的修饰符符号
function fmtHint(raw: string): string {
  if (!raw) return "";
  let s = raw.replace(/⌘/g, MOD_SYM).replace(/⌥/g, ALT_SYM);
  // 在修饰符与按键之间补一个空格，保证 Windows/Linux 下可读：Ctrl N / Ctrl Alt ↑
  s = s.replace(/(⌘|Ctrl|⇧|Alt|⌥)(?=[A-Za-z0-9↑↓←→])/g, "$1 ");
  return s.trim();
}

function escapeHtmlFor(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightRanges(text: string, ranges: Array<[number, number]>): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let html = "";
  let last = 0;
  for (const [s, e] of sorted) {
    if (s < last) continue;
    html += escapeHtmlFor(text.slice(last, s));
    html += "<mark>" + escapeHtmlFor(text.slice(s, e)) + "</mark>";
    last = e;
  }
  html += escapeHtmlFor(text.slice(last));
  return html;
}

function themeBase(): import("@codemirror/state").Extension {
  return EditorView.theme(
    {
      "&": { height: "100%", fontSize: "var(--ed-font)", backgroundColor: "var(--ed-bg)", color: "var(--ed-fg)" },
      ".cm-scroller": { fontFamily: "var(--mono)", overflow: "auto" },
      ".cm-content": { caretColor: "var(--accent)", fontFamily: "var(--mono)" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--ed-sel) !important" },
      ".cm-gutters": { backgroundColor: "var(--ed-gutter)", color: "var(--ed-line-num)", borderRight: "1px solid var(--border)" },
      ".cm-activeLine": { backgroundColor: "var(--ed-active-line)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--ed-active-line)", color: "var(--ed-line-num-active)" },
      ".cm-matchingBracket": { backgroundColor: "var(--ed-bracket)" },
      ".cm-nonmatchingBracket": { backgroundColor: "var(--ed-bracket)" },
      ".cm-tooltip": { backgroundColor: "var(--bg2)", color: "var(--fg)", border: "1px solid var(--border)" },
      ".cm-panels": { backgroundColor: "var(--bg2)", color: "var(--fg)" },
      "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--ed-sel) !important" },
      ".cm-searchMatch": { backgroundColor: "var(--ed-search-match)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--ed-search-match-sel)" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--bg2)", border: "1px solid var(--border)", color: "var(--fg-dim)" },
    },
    { dark: false },
  );
}

export class App {
  private view: EditorView | null = null;
  private docs = new Map<string, Document>();
  private tabOrder: string[] = [];
  private activeId: string | null = null;
  private editorEl: HTMLElement;
  private mainPanel: HTMLElement;
  private splitPanel: HTMLElement;
  private previewPanel!: HTMLElement;
  private preview: MarkdownPreview | null = null;
  private previewOn = false;
  private prefWrap = false;
  private prefWs = false;
  private prefPreview = false;
  private previewTimer: any = null;
  private splitView: EditorView | null = null;
  private splitDocId: string | null = null;
  private hexEl: HTMLElement;
  private tabbarEl: HTMLElement;
  private emptyStateEl: HTMLElement;
  private statusEls: Record<string, HTMLElement>;
  private hex: HexEditor;
  private find: FindBar;
  private tree: FileTree;
  private hexRoot: HTMLElement;
  private searchDir = "";
  private fileSearch: FileSearch;
  private palette: CommandPalette;
  private outline: Outline;
  private searchItems: Array<{ path: string; line: number; content: string }> = [];
  private autosave = false;
  private autosaveTimer: number | null = null;

  constructor() {
    this.editorEl = document.getElementById("editor-container")!;
    this.mainPanel = document.getElementById("main-panel")!;
    this.splitPanel = document.getElementById("split-panel")!;
    this.previewPanel = document.getElementById("preview-panel")!;
    this.hexEl = document.getElementById("hex-container")!;
    this.tabbarEl = document.getElementById("tabbar")!;
    this.emptyStateEl = document.getElementById("empty-state")!;
    this.hexRoot = this.hexEl;
    this.statusEls = {
      path: document.getElementById("status-path")!,
      encoding: document.getElementById("status-encoding")!,
      lang: document.getElementById("status-lang")!,
      size: document.getElementById("status-size")!,
      pos: document.getElementById("status-pos")!,
    };
    this.hex = new HexEditor(this.hexEl, () => this.onHexDirty());
    this.hex.onCursorCb = (o) => {
      this.statusEls.pos.textContent = `${t("偏移")} ${o.toString(16).toUpperCase()}`;
    };
    this.fileSearch = new FileSearch(
      (p, l) => this.openFileAtLine(p, l),
      (items) => {
        this.searchItems = items.map((i) => ({ path: i.path, line: i.line, content: i.content }));
        this.renderSearchPanel();
      },
    );
    this.palette = new CommandPalette();
    this.outline = new Outline(document.getElementById("outline-panel")!, (line) => this.gotoLineInActive(line));
    this.outline.bind();
    new RemoteBrowser(
      document.getElementById("remote-panel")!,
      (tmp, proto, id, remotePath) => this.openRemoteDoc(tmp, proto, id, remotePath),
      () => this.active?.path ?? "",
    );
    this.bindSidebarTabs();
    this.bindSidebarResize();
    this.restoreSidebarCollapsed();
    document.getElementById("sb-toggle")?.addEventListener("click", () => this.toggleSidebar());
    this.find = new FindBar(document.getElementById("searchbar")!, () => this.view);
    this.tree = new FileTree(document.getElementById("filetree")!, (p) => this.openFile(p));
    this.hexRoot = this.hexEl;
  }

  init() {
    this.loadSettings();
    this.buildMenus();
    onLangChange(() => {
      this.closeMenus();
      this.buildMenus();
      this.localizeEmptyState();
      this.localizeFindBar();
      this.localizeShell();
      this.renderTabs();
      this.updateStatus();
    });
    this.localizeEmptyState();
    this.localizeFindBar();
    this.localizeShell();
    this.bindToolbar();
    this.bindGlobalKeys();
    this.bindDrop();
    this.bindCloseHook();
    this.newDoc();
    this.loadHome();
    this.checkRecovery();
    void this.restoreSession();
  }

  private bindCloseHook() {
    this.saveSessionSoon();
    try {
      getCurrentWindow().onCloseRequested(async (event) => {
        this.saveSessionNow();
        const dirty = [...this.docs.values()].filter((d) => d.dirty);
        if (!dirty.length) return;
        event.preventDefault();
        let saved = 0;
        for (const d of dirty) {
          try {
            if (d.path && d.state) {
              const ok = await this.saveDocument(d);
              if (ok) saved++;
            } else if (d.state) {
              await invoke("write_recovery", { key: d.id, name: d.name, text: d.state.doc.toString() }).catch(() => {});
              saved++;
            }
          } catch {
            /* ignore */
          }
        }
        window.setTimeout(() => {
          try {
            getCurrentWindow().destroy();
          } catch {
            window.close();
          }
        }, 30);
      });
    } catch {
      /* not in tauri */
    }
  }

  private saveSessionNow() {
    try {
      const paths = [...this.docs.values()]
        .filter((d) => d.path && !d.isBinary && !d.remote)
        .map((d) => d.path);
      localStorage.setItem("uec.session.paths", JSON.stringify(paths));
    } catch {
      /* ignore */
    }
  }

  private saveSessionSoon() {
    window.setInterval(() => this.saveSessionNow(), 30000);
  }

  private async restoreSession() {
    try {
      const raw = localStorage.getItem("uec.session.paths");
      if (!raw) return;
      const paths = JSON.parse(raw) as string[];
      if (!Array.isArray(paths)) return;
      for (const p of paths.slice(0, 8)) {
        await this.openFile(p).catch(() => {});
      }
      if (paths.length > 8) {
        this.statusEls.pos.textContent = t("已恢复标签，其余 {n} 个未打开", { n: paths.length - 8 });
      }
      if (this.prefPreview) {
        const d = this.active;
        if (d && d.mode !== "hex" && isMarkdownDoc(d.path, d.name)) this.openPreview();
      }
    } catch {
      /* ignore */
    }
  }

  private async checkRecovery() {
    try {
      const items = await invoke<Array<{ key: string; name: string; modified: string }>>("list_recovery");
      if (items.length) this.recoveryDialog(items);
    } catch {
      /* ignore */
    }
  }

  private recoveryDialog(items: Array<{ key: string; name: string; modified: string }>) {
    const rows = items.map((it) =>
      `<div class="rec-item" data-key="${it.key}"><span class="rec-name">${escapeHtmlFor(it.name)}</span><span class="rec-meta">${escapeHtmlFor(it.modified)}</span></div>`).join("");
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:420px;"><div class="modal-title">${t("发现 {n} 个未保存的文档", { n: items.length })}</div>
      <div class="modal-body">${t("以下内容是在上次会话中未保存的（崩溃/退出），点击可恢复：")}</div>
      <div class="rec-list">${rows}</div>
      <div class="modal-actions" style="margin-top:12px;">
        <button data-act="ignore">${t("全部忽略")}</button>
        <button data-act="clear" class="primary">${t("清除全部")}</button>
      </div></div>`;
    modal.querySelector(".rec-list")!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
      if (!el) return;
      const key = el.dataset.key!;
      const name = items.find((i) => i.key === key)?.name ?? t("恢复文档");
      modal.remove();
      void this.openRecovery(key, name);
    });
    modal.querySelector('[data-act="ignore"]')!.addEventListener("click", () => modal.remove());
    modal.querySelector('[data-act="clear"]')!.addEventListener("click", async () => {
      for (const it of items) await invoke("clear_recovery", { key: it.key }).catch(() => {});
      modal.remove();
      this.alert(t("已清除全部恢复文件。"));
    });
    document.body.appendChild(modal);
  }

  private async openRecovery(key: string, name: string) {
    const text = await invoke<string>("read_recovery", { key }).catch(() => "");
    if (!text) return;
    const tmp: Document = {
      id: "",
      path: name,
      name,
      encoding: "utf-8",
      lineEnding: "lf",
      isBinary: false,
      mode: "text",
      dirty: false,
      size: 0,
      truncated: false,
      wrap: this.active?.wrap,
      showWs: this.active?.showWs,
    };
    const doc: Document = {
      id: uid(),
      path: "",
      name: name + t("[恢复]"),
      encoding: "utf-8",
      lineEnding: "lf",
      isBinary: false,
      mode: "text",
      dirty: true,
      state: EditorState.create({ doc: text, extensions: this.extForDoc(tmp) }),
      size: text.length,
      truncated: false,
    };
    this.addDoc(doc);
    window.setTimeout(() => this.alert(t("已恢复。请检查内容后保存。")), 50);
  }

  private renderSearchPanel() {
    const el = document.getElementById("search-panel")!;
    if (!this.searchItems.length) {
      el.innerHTML = `<div class="outline-empty">${t("暂无搜索结果（使用 在文件中查找…）")}</div>`;
      return;
    }
    el.innerHTML = "";
    const frag = document.createDocumentFragment();
    let lastFile = "";
    for (const it of this.searchItems) {
      if (it.path !== lastFile) {
        lastFile = it.path;
        const head = document.createElement("div");
        head.className = "fs-file";
        head.textContent = it.path;
        frag.appendChild(head);
      }
      const row = document.createElement("div");
      row.className = "fs-item";
      row.dataset.file = it.path;
      row.dataset.line = String(it.line);
      row.innerHTML = `<span class="fs-line-no">${it.line}</span><span class="fs-line-text">${escapeHtmlFor(it.content)}</span>`;
      frag.appendChild(row);
    }
    el.appendChild(frag);
    el.querySelectorAll("[data-file]").forEach((node) => {
      node.addEventListener("click", () => {
        this.openFileAtLine((node as HTMLElement).dataset.file!, parseInt((node as HTMLElement).dataset.line || "1", 10));
      });
    });
  }

  private bindSidebarResize() {
    const sb = document.getElementById("sidebar")!;
    const handle = document.querySelector<HTMLElement>(".sb-resize-handle");
    if (!handle) return;
    try {
      const saved = parseInt(localStorage.getItem("uec.sidebar.w") || "", 10);
      if (saved > 0) sb.style.width = saved + "px";
    } catch {
      /* ignore */
    }
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sb.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        const w = Math.max(140, Math.min(560, startW + (ev.clientX - startX)));
        sb.style.width = w + "px";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        try {
          localStorage.setItem("uec.sidebar.w", String(Math.round(sb.getBoundingClientRect().width)));
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private bindSidebarTabs() {
    const header = document.getElementById("sidebar-header")!;
    document.getElementById("tabbar")?.classList.toggle("wrap", localStorage.getItem("uec.tabwrap") === "1");
    header.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>(".sb-tab");
      if (!tab) return;
      const name = tab.dataset.sb;
      header.querySelectorAll(".sb-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("filetree")!.classList.toggle("hidden", name !== "local");
      document.getElementById("outline-panel")!.classList.toggle("hidden", name !== "outline");
      document.getElementById("search-panel")!.classList.toggle("hidden", name !== "search");
      document.getElementById("remote-panel")!.classList.toggle("hidden", name !== "remote");
      if (name === "outline") this.refreshOutline();
    });
  }

  private gotoLineInActive(line: number) {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    const ln = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
    v.dispatch({
      selection: { anchor: ln.from },
      effects: [EditorView.scrollIntoView(ln.from, { y: "center" })],
    });
    v.focus();
  }

  private refreshOutline() {
    const doc = this.active;
    const v = this.view;
    if (!doc || !v || doc.mode === "hex" || !doc.path) {
      this.outline.clear();
      return;
    }
    this.outline.render(doc.path, v.state.doc.toString());
  }

  private bindDrop() {
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;
      const paths: string[] = [];
      for (const f of files) {
        const p = (f as unknown as { path?: string }).path;
        if (p) paths.push(p);
      }
      if (paths.length) {
        this.openFiles(paths);
      }
    });
  }

  private async openFiles(paths: string[]) {
    const isDir: boolean[] = await Promise.all(
      paths.map((p) => invoke<boolean>("path_is_dir", { path: p }).catch(() => false)),
    );
    const firstDir = paths.find((_, i) => isDir[i]);
    if (firstDir && !paths.some((_, i) => !isDir[i])) {
      this.searchDir = firstDir;
      await this.tree.showRoot(firstDir);
      return;
    }
    for (let i = 0; i < paths.length; i++) {
      if (isDir[i]) {
        this.searchDir = paths[i];
        await this.tree.showRoot(paths[i]);
      } else {
        await this.openFile(paths[i]);
      }
    }
  }

  private loadHome() {
    invoke<string>("home_dir").then((h) => {
      this.tree.showRoot(h);
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- docs

  async newDoc() {
    const doc: Document = {
      id: uid(),
      path: "",
      name: t("无标题 1"),
      encoding: "utf-8",
      lineEnding: "lf",
      isBinary: false,
      mode: "text",
      dirty: false,
      size: 0,
      truncated: false,
    };
    this.addDoc(doc);
  }

  private addDoc(doc: Document) {
    this.docs.set(doc.id, doc);
    this.tabOrder.push(doc.id);
    this.renderTabs();
    this.activate(doc.id);
  }

  private get active(): Document | null {
    return this.activeId ? (this.docs.get(this.activeId) ?? null) : null;
  }

  async openFile(path: string) {
    const existing = [...this.docs.values()].find((d) => d.path === path && d.mode === "text");
    if (existing) {
      this.activate(existing.id);
      return;
    }
    let res;
    try {
      res = await invoke<{ text: string; truncated: boolean; encoding: string; size: number; is_binary: boolean; line_endings: string }>("read_text_file", { path });
    } catch (e) {
      this.alert(t("无法打开文件：") + `\n${e}`);
      return;
    }
    addRecent(path);
    const name = path.split(/[\\/]/).pop() || path;
    const doc: Document = {
      id: uid(),
      path,
      name,
      encoding: res.encoding,
      lineEnding: res.is_binary ? "lf" : (res.line_endings || "lf"),
      isBinary: res.is_binary,
      mode: "text",
      dirty: false,
      size: res.size,
      truncated: res.truncated,
    };
    if (res.is_binary) {
      doc.mode = "hex";
      doc.isBinary = true;
    } else {
      doc.state = EditorState.create({
        doc: res.text,
        extensions: this.extForDoc(doc),
      });
    }
    this.addDoc(doc);
    this.saveSessionNow();
    if (res.truncated) {
      this.showBigOpenChoice(doc);
    }
  }

  private showBigOpenChoice(doc: Document) {
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:380px;"><div class="modal-title">${t("文件较大")}</div><div class="modal-body">
      ${t("已加载前 20MB（{edit}）。如需查看/编辑整个大文件，可用分页模式。", { edit: doc.path ? t("可编辑此部分") : "" })}
      <div class="modal-actions" style="margin-top:14px;">
        <button data-big class="primary">${t("分页查看/编辑整个文件")}</button>
        <button data-cancel>${t("继续编辑当前部分")}</button>
      </div>
    </div></div>`;
    if (!doc.path) {
      modal.querySelector("[data-big]")!.remove();
    }
    modal.querySelector("[data-big]")?.addEventListener("click", () => {
      modal.remove();
      showBigViewer(doc.path!);
    });
    modal.querySelector("[data-cancel]")!.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  }

  private extForDoc(doc: Document): import("@codemirror/state").Extension[] {
    const lang = doc.path ? langForPath(doc.path) : { ext: [], name: t("纯文本") };
    const base: import("@codemirror/state").Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [snippetCompletionSource, kwSourceFor(doc.path || "")] }),
      syntaxHighlighting(defaultHighlightStyle),
      highlightSelectionMatches(),
      search(),
      searchHighlight(),
      foldGutter(),
      keymap.of(foldKeymap),
      bookmarks(),
      editPositionListener,
      clipListener,
      webkitFocusScrollGuard,
      macroExtension(),
      wrapCompartment.of(this.prefWrap ? EditorView.lineWrapping : []),
      wsCompartment.of(this.prefWs ? [highlightWhitespace()] : []),
      langCompartment.of(isMarkdownDoc(doc.path, doc.name) ? markdown({ base: markdownLanguage }) : []),
      themeBase(),
      rectangleSelection,
      EditorView.updateListener.of((u) => this.onEditorUpdate(u)),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...closeBracketsKeymap,
        ...completionKeymap,
        {
          key: "Tab",
          run: (v) => {
            if (v.state.selection.ranges.length > 1 && !v.state.selection.main.empty) {
              return indentMore(v);
            }
            return insertTab(v);
          },
        },
        { key: "Shift-Tab", run: indentLess },
        { key: "Enter", run: insertNewlineAndIndent },
        { key: "Mod-Shift-d", run: copyLineDown },
        { key: "Mod-Shift-K", run: deleteLine },
        { key: "Mod-Shift-Alt-Up", run: moveLineUp },
        { key: "Mod-Shift-Alt-Down", run: moveLineDown },
        { key: "Mod-J", run: joinLines },
        { key: "Mod-u", run: upperCaseCmd },
        { key: "Mod-Shift-u", run: lowerCaseCmd },
        { key: "Mod-Y", run: toggleCaseCmd },
        { key: "Mod-/", run: toggleComment },
        { key: "Mod-Alt-ArrowUp", run: addCursorAbove },
        { key: "Mod-Alt-ArrowDown", run: addCursorBelow },
        { key: "F2", run: nextBookmark },
        { key: "Shift-F2", run: prevBookmark },
        { key: "Mod-F2", run: toggleBookmark },
        { key: "Mod--", run: jumpBack },
        { key: "Mod-Shift--", run: jumpForward },
      ]),
    ];
    if (lang.ext) base.push(lang.ext);
    return base;
  }

  private onEditorUpdate(u: import("@codemirror/view").ViewUpdate) {
    const doc = this.active;
    if (!doc) return;
    doc.state = u.state;
    if (u.docChanged) {
      doc.dirty = true;
      this.updateTabDot(doc);
    }
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.updateStatus();
    }
    if (u.docChanged && !document.getElementById("outline-panel")!.classList.contains("hidden")) {
      this.refreshOutline();
    }
    if (u.docChanged && this.previewOn) this.schedulePreview();
  }

  private activate(id: string) {
    const prev = this.active;
    if (prev && prev.id !== id && this.view) {
      prev.scrollTop = this.view.scrollDOM.scrollTop;
    }
    this.activeId = id;
    const doc = this.docs.get(id)!;
    if (doc.mode === "hex") {
      if (this.previewOn) this.closePreview();
      this.editorEl.classList.add("hidden");
      this.hexEl.classList.remove("hidden");
      this.emptyStateEl.classList.add("hidden");
      this.hex.open(doc);
      this.hexRoot.classList.remove("hidden");
      this.statusEls.lang.textContent = t("二进制");

    } else {
      this.hexEl.classList.add("hidden");
      this.hexRoot.classList.add("hidden");
      if (!this.view) {
        this.view = new EditorView({ parent: this.mainPanel });
      }
      this.editorEl.classList.remove("hidden");
      this.emptyStateEl.classList.add("hidden");
      let didSet = false;
      if (doc.state) {
        if (this.view.state !== doc.state) {
          this.view.setState(doc.state);
          didSet = true;
        }
      } else {
        const state = EditorState.create({ doc: "", extensions: this.extForDoc(doc) });
        doc.state = state;
        this.view.setState(state);
        didSet = true;
      }
      if (didSet && doc.scrollTop != null) {
        const target = doc.scrollTop;
        requestAnimationFrame(() => {
          if (this.activeId === id && this.view && this.view.scrollDOM) {
            this.view.scrollDOM.scrollTop = target;
          }
        });
      }
      this.view.dispatch({
        effects: [
          wrapCompartment.reconfigure(this.prefWrap ? EditorView.lineWrapping : []),
          wsCompartment.reconfigure(this.prefWs ? [highlightWhitespace()] : []),
        ],
      });
      this.view.focus();
      this.statusEls.lang.textContent = doc.path ? langForPath(doc.path).name : t("纯文本");
    }
    this.renderTabs();
    this.updateStatus();
    this.updateModeButton();
    this.updateColumnButton();
    if (this.previewOn) this.refreshPreview();
  }

  private updateStatus() {
    const doc = this.active;
    if (!doc) return;
    this.statusEls.path.textContent = doc.path || t(doc.name);
    this.statusEls.encoding.textContent = `${doc.encoding} · ${lineEndingLabel(doc.lineEnding)}`;
    this.statusEls.lang.textContent = doc.path ? langForPath(doc.path).name : t("纯文本");
    if (doc.mode === "hex") {
      this.statusEls.size.textContent = formatSize(doc.hexBytes?.length ?? doc.size);
    } else {
      const len = doc.state?.doc.length ?? 0;
      this.statusEls.size.textContent = `${len} ${t("字符")}`;
      const v = this.view;
      if (v) {
        const sel = v.state.selection.main;
        const line = v.state.doc.lineAt(sel.head);
        const col = sel.head - line.from + 1;
        this.statusEls.pos.textContent = `Ln ${line.number}, Col ${col}`;
      }
    }
  }

  private updateTabDot(doc: Document) {
    const tab = this.tabbarEl.querySelector<HTMLElement>(`[data-tab="${doc.id}"]`);
    if (!tab) return;
    const dot = tab.querySelector<HTMLElement>(".tab-dot");
    if (dot) dot.style.opacity = doc.dirty ? "1" : "0";
  }

  private renderTabs() {
    this.tabbarEl.innerHTML = "";
    let dragId: string | null = null;
    for (const id of this.tabOrder) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      const tab = document.createElement("div");
      tab.className = "tab";
      tab.draggable = true;
      if (doc.id === this.activeId) tab.classList.add("active");
      tab.dataset.tab = doc.id;
      tab.dataset.path = doc.path;
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = t(doc.name) + (doc.isBinary ? " [" + t("二进制") + "]" : "");
      name.title = doc.path || t(doc.name);
      const dot = document.createElement("span");
      dot.className = "tab-dot";
      dot.textContent = "●";
      dot.style.opacity = doc.dirty ? "1" : "0";
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "✕";
      tab.append(name, dot, close);
      tab.addEventListener("dragstart", (e) => {
        dragId = doc.id;
        e.dataTransfer!.effectAllowed = "move";
      });
      tab.addEventListener("dragover", (e) => {
        e.preventDefault();
      });
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragId || dragId === doc.id) return;
        const from = this.tabOrder.indexOf(dragId);
        const to = this.tabOrder.indexOf(doc.id);
        if (from < 0 || to < 0) return;
        this.tabOrder.splice(from, 1);
        this.tabOrder.splice(to, 0, dragId);
        dragId = null;
        this.renderTabs();
      });
      tab.addEventListener("dragend", () => {
        dragId = null;
      });
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(doc.id);
      });
      tab.addEventListener("mousedown", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.closeTab(doc.id);
        }
      });
      tab.addEventListener("click", () => this.activate(doc.id));
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showTabMenu(e.clientX, e.clientY, doc);
      });
      this.tabbarEl.appendChild(tab);
    }
  }

  private showTabMenu(x: number, y: number, doc: Document) {
    const items: Array<[string, () => void]> = [
      ["在分屏中打开", () => this.openInSplit(doc.id)],
      ["关闭", () => this.closeTab(doc.id)],
      ["关闭其他标签", () => {
        for (const d of [...this.docs.values()]) if (d.id !== doc.id) this.closeTab(d.id);
      }],
      ["关闭所有标签", () => {
        for (const d of [...this.docs.values()]) this.closeTab(d.id);
      }],
      ["复制路径", () => {
        navigator.clipboard.writeText(doc.path || doc.name);
      }],
    ];
    this.showMenu(x, y, items);
  }

  // ---------------------------------------------------------------- menu

  private menuData: Record<string, () => Array<[string, () => void, string?]>> = {
    "文件": () => [
      ["新建", () => this.newDoc(), "⌘N"],
      ["打开文件…", () => this.openDialog(), "⌘O"],
      ["打开文件夹…", () => this.openFolderDialog(), ""],
      ["---", () => {}, ""],
      ["保存", () => this.save(false), "⌘S"],
      ["另存为…", () => this.save(true), "⇧⌘S"],
      ["导出为 HTML（可打印/存 PDF）", () => this.exportHtml(), ""],
      ["导出 Markdown（HTML/PDF）", () => this.exportMarkdown(), ""],
      ["导出为 Word（.doc）", () => this.exportWord(), ""],
      ["打印…", () => this.printActive(), "⌘P"],
      ["编码转换…", () => this.encodingDialog(), ""],
      ["关闭标签", () => this.active && this.closeTab(this.active.id), "⌘W"],
      ["新窗口", () => invoke("new_window").catch((e) => this.alert(t("无法打开新窗口：") + `\n${e}`)), ""],
      ["---", () => {}, ""],
      ...this.recentMenuItems(),
      ["---", () => {}, ""],
      ["退出", () => { try { getCurrentWindow().close(); } catch { window.close(); } }, ""],
    ],
    "编辑": () => [
      ["撤销", () => this.exec("undo"), "⌘Z"],
      ["重做", () => this.exec("redo"), "⇧⌘Z"],
      ["---", () => {}, ""],
      ["剪切", () => this.exec("cut"), "⌘X"],
      ["复制", () => this.exec("copy"), "⌘C"],
      ["粘贴", () => this.exec("paste"), "⌘V"],
      ["全选", () => this.exec("selectAll"), "⌘A"],
      ["---", () => {}, ""],
      ["复制当前行", () => this.execCmd(copyLineDown), "⇧⌘D"],
      ["删除当前行", () => this.execCmd(deleteLine), "⇧⌘K"],
      ["上移当前行", () => this.execCmd(moveLineUp), ""],
      ["下移当前行", () => this.execCmd(moveLineDown), ""],
      ["合并下一行", () => this.execCmd(joinLines), "⌘J"],
      ["---", () => {}, ""],
      ["大写", () => this.execCmd(upperCaseCmd), "⌘U"],
      ["小写", () => this.execCmd(lowerCaseCmd), "⇧⌘U"],
      ["首字母大写", () => this.execCmd(titleCaseSelection), ""],
      ["---", () => {}, ""],
      ["列编辑模式", () => this.toggleColumn(), "⌘L"],
      ["添加上方光标", () => this.execCmd(addCursorAbove), "⌘⌥↑"],
      ["添加下方光标", () => this.execCmd(addCursorBelow), "⌘⌥↓"],
      ["---", () => {}, ""],
      ["注释/取消注释", () => this.execCmd(toggleComment), "⌘/"],
      ["缩进 → 空格", () => this.applyTool(indentToSpaces), ""],
      ["空格 → 缩进", () => this.applyTool(indentToTabs), ""],
      ["---", () => {}, ""],
      ["行排序…", () => this.sortDialog(), ""],
      ["插入数字序列…（列）", () => this.numSeqDialog(), ""],
      ["转换行尾 (CRLF)", () => this.convertLE("crlf"), ""],
      ["转换行尾 (LF)", () => this.convertLE("lf"), ""],
      ["转换行尾 (CR)", () => this.convertLE("cr"), ""],
      ["---", () => {}, ""],
      ["删除重复行", () => this.deleteDuplicateLines(), ""],
      ["删除空行", () => this.deleteBlankLines(), ""],
      ["删除行尾空格", () => this.trimTrailingWhitespace(), ""],
      ["压缩连续空行", () => this.compressBlankLines(), ""],
      ["硬换行…", () => this.rewrapDialog(), ""],
      ["插入日期/时间…", () => this.insertDateTimeDialog(), ""],
      ["插入字符/ASCII 表…", () => this.charTableDialog(), ""],
      ["---", () => {}, ""],
      ["录制/停止宏", () => this.execCmd(toggleRecordMacro), ""],
      ["播放宏", () => this.execCmd(runMacro), ""],
      ["清除宏", () => this.execCmd(clearMacro), ""],
      ["宏管理…", () => {
        const v = this.view;
        if (v) macroManagerDialog(v, (m) => { this.statusEls.pos.textContent = m; });
      }, ""],
      ["代码片段…", () => snippetManagerDialog(), ""],
      ["剪贴板历史…", () => this.openClipHist(), ""],
    ],
    "工具": () => [
      ["JSON 格式化", () => this.applyTool(formatJson), ""],
      ["JSON 压缩", () => this.applyTool(minifyJson), ""],
      ["HTML 格式化", () => this.applyTool(formatHtml), ""],
      ["XML 格式化", () => this.applyTool(formatXml), ""],
      ["---", () => {}, ""],
      ["文本转换…", () => this.view && textConvertDialog(this.view), ""],
      ["---", () => {}, ""],
      ["字数统计…", () => this.wordCountDialog(), ""],
      ["拼写检查…", () => this.openSpellCheck(), ""],
      ["文件比较…", () => showDiffDialog(this.openDocRefs()), ""],
      ["目录比较/同步…", () => showDirCompare(), ""],
      ["脚本编辑器…", () => showScriptDialog(), ""],
      ["在终端中打开", () => this.openTerminalHere(), ""],
      ["大文件查看/编辑…", async () => {
        const dir = this.activeFileDir();
        if (!dir) {
          this.alert(t("请先打开一个文件。"));
          return;
        }
        const picked = await dialogOpen({ multiple: false, title: "选择大文件" });
        if (!picked) return;
        showBigViewer(picked);
      }, ""],
    ],
    "查找": () => [
      ["查找…", () => this.find.open(), "⌘F"],
      ["替换…", () => this.find.open({ replace: true }), "⇧⌘F"],
      ["查找下一个", () => this.exec("findNext"), "F3"],
      ["查找上一个", () => this.exec("findPrev"), "⇧F3"],
      ["全选所有匹配", () => this.exec("selectMatches"), ""],
      ["列出所有匹配行…", () => this.listMatchesInFile(), ""],
      ["---", () => {}, ""],
      ["在文件中查找…", () => this.openFileSearch(false), "⌥⌘F"],
      ["在文件中替换…", () => this.openFileSearch(true), "⌥⌘H"],
    ],
    "转到": () => [
      ["跳转到行…", () => this.gotoLineDialog(), "⌘G"],
      ["---", () => {}, ""],
      ["设置/取消书签", () => this.execCmd(toggleBookmark), "⌘F2"],
      ["下一个书签", () => this.execCmd(nextBookmark), "F2"],
      ["上一个书签", () => this.execCmd(prevBookmark), "⇧F2"],
      ["清除所有书签", () => this.execCmd(clearAllBookmarks), ""],
      ["---", () => {}, ""],
      ["上一个编辑位置", () => this.execCmd(jumpBack), "⌘-"],
      ["下一个编辑位置", () => this.execCmd(jumpForward), "⇧⌘-"],
      ["---", () => {}, ""],
      ["命令面板", () => this.openPalette(), "⇧⌘P"],
    ],
    "视图": () => [
      ["切换侧边栏", () => this.toggleSidebar(), "⌘B"],
      ["切换主题", () => this.toggleTheme(), ""],
      ["切换文本/十六进制", () => this.toggleMode(), ""],
      ["标签列表…", () => this.showTabList(), "⇧⌘E"],
      ["拆分/合并窗口", () => this.toggleSplit(), "⌘\\"],
      [this.previewOn ? t("关闭预览") : t("Markdown 预览"), () => this.togglePreview(), ""],
      ["自动换行", () => this.toggleWrap(), ""],
      ["显示空白字符", () => this.toggleWhitespace(), ""],
      ["标签换行模式", () => this.toggleTabWrap(), ""],
      ["自动保存", () => this.toggleAutosave(), ""],
      ["设置…", () => this.settingsDialog(), ""],
          ["清空最近文件", () => { clearRecent(); this.alert(t("已清空最近文件列表。")); }, ""],
    ],
    "帮助": () => [
      ["检查更新…", () => this.checkForUpdate(), ""],
      ["关于", () => this.alert(t("about.text")), ""],
    ],
    "语言": () => [
      ["简体中文", () => setLang("zh-CN"), ""],
      ["English", () => setLang("en-US"), ""],
      ["日本語", () => setLang("ja-JP"), ""],
    ],
  };

  private recentMenuItems(): Array<[string, () => void, string?]> {
    const recent = getRecent();
    if (!recent.length) return [["（无最近文件）", () => {}, ""]];
    return [
      ...recent.map((p): [string, () => void, string?] => {
        const name = p.split(/[\\/]/).pop() || p;
        return [name, () => this.openFile(p), ""];
      }),
    ];
  }

  private localizeEmptyState() {
    const p = this.emptyStateEl.querySelector("p");
    if (p) p.textContent = t("打开文件、编辑、十六进制查看，全部功能都在这里。");
    this.emptyStateEl.querySelectorAll<HTMLElement>("button[data-action]").forEach((b) => {
      const a = b.dataset.action;
      if (a === "open") b.textContent = t("打开文件");
      else if (a === "open-folder") b.textContent = t("打开文件夹");
      else if (a === "new") b.textContent = t("新建文件");
    });
    this.renderEmptyRecent();
  }

  private renderEmptyRecent() {
    const box = document.getElementById("empty-recent");
    if (!box) return;
    const recent = getRecent();
    if (!recent.length) {
      box.innerHTML = "";
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    const items = recent.slice(0, 8).map((p) => {
      const name = p.split(/[\\/]/).pop() || p;
      return `<button class="empty-recent-item" data-action="open-recent" data-path="${escapeHtmlFor(p)}" title="${escapeHtmlFor(p)}"><span class="eri-name">${escapeHtmlFor(name)}</span><span class="eri-path">${escapeHtmlFor(p)}</span></button>`;
    }).join("");
    box.innerHTML = `<div class="empty-recent-h">${t("最近文件")}</div>${items}`;
  }

  private localizeFindBar() {
    const set = (id: string, attr: "text" | "placeholder", val: string) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (attr === "text") el.textContent = val;
      else (el as HTMLInputElement).placeholder = val;
    };
    set("search-input", "placeholder", t("查找..."));
    set("replace-input", "placeholder", t("替换为..."));
    set("lbl-case", "text", t("区分大小写"));
    set("lbl-regex", "text", t("正则"));
    set("lbl-word", "text", t("全词"));
    set("lbl-whole", "text", t("循环"));
    set("search-count", "text", t("计数"));
    set("search-bookmark", "text", t("书签全部"));
    set("replace-one", "text", t("替换"));
    set("replace-all", "text", t("全部替换"));
    set("replace-sel", "text", t("选中替换"));
    const count = document.getElementById("search-count");
    if (count) count.title = t("统计匹配数量");
    const bm = document.getElementById("search-bookmark");
    if (bm) bm.title = t("为所有匹配行添加书签");
    const prev = document.getElementById("search-prev");
    if (prev) prev.title = t("查找上一个");
    const next = document.getElementById("search-next");
    if (next) next.title = t("查找下一个");
    const close = document.getElementById("search-close");
    if (close) close.title = t("关闭") + " (Esc)";
  }

  private localizeShell() {
    const titleOf = (act: string) => document.querySelector(`[data-action="${act}"]`);
    const tb: Record<string, [string, string?]> = {
      new: ["新建", "⌘N"],
      open: ["打开文件", "⌘O"],
      "open-folder": ["打开文件夹"],
      save: ["保存", "⌘S"],
      undo: ["撤销", "⌘Z"],
      redo: ["重做", "⇧⌘Z"],
      find: ["查找", "⌘F"],
      replace: ["替换", "⇧⌘F"],
      column: ["列模式"],
      mode: ["切换文本/十六进制"],
      tree: ["切换侧边栏"],
      theme: ["切换主题"],
    };
    for (const [act, [key, hint]] of Object.entries(tb)) {
      const el = titleOf(act);
      if (el) el.setAttribute("title", hint ? `${t(key)} (${fmtHint(hint)})` : t(key));
    }
    const handle = document.querySelector(".sb-resize-handle");
    if (handle) handle.setAttribute("title", t("拖拽调整宽度"));
    const sbToggle = document.getElementById("sb-toggle");
    if (sbToggle) {
      sbToggle.setAttribute("title", `${t("折叠/展开侧边栏")} (${fmtHint("⌘B")})`);
      sbToggle.setAttribute("aria-label", t("折叠侧边栏"));
    }
    const tabs: Record<string, string> = {
      local: "本地",
      outline: "大纲",
      search: "搜索",
      remote: "远程",
    };
    for (const [sb, key] of Object.entries(tabs)) {
      const el = document.querySelector(`.sb-tab[data-sb="${sb}"]`);
      if (el) el.textContent = t(key);
    }
    const emptyP = document.querySelector("#empty-state p");
    if (emptyP) emptyP.textContent = t("打开文件、编辑、十六进制查看，全部功能都在这里。");
    const emptyBtns: Record<string, string> = {
      open: "打开文件",
      "open-folder": "打开文件夹",
      new: "新建文件",
    };
    for (const [act, key] of Object.entries(emptyBtns)) {
      const el = document.querySelector(`#empty-state [data-action="${act}"]`);
      if (el) el.textContent = t(key);
    }
  }

  private buildMenus() {
    const bar = document.getElementById("menubar")!;
    bar.innerHTML = "";
    for (const label of Object.keys(this.menuData)) {
      const item = document.createElement("div");
      item.className = "menu-item";
      item.textContent = t(label);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showMenuAt(item, this.menuData[label]());
      });
      bar.appendChild(item);
    }
  }

  private showMenuAt(anchor: HTMLElement, items: Array<[string, () => void, string?]>) {
    this.closeMenus();
    const rect = anchor.getBoundingClientRect();
    this.showMenu(rect.left, rect.bottom, items.map((i) => [i[0], i[1], i[2]] as [string, () => void, string?]));
  }

  private showMenu(x: number, y: number, items: Array<[string, () => void, string?]>) {
    this.closeMenus();
    const langMark = { "zh-CN": "简体中文", "en-US": "English", "ja-JP": "日本語" }[getLang()];
    const menu = document.createElement("div");
    menu.className = "dropdown-menu";
    for (const [label, fn, hint] of items) {
      if (label === "---") {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        menu.appendChild(sep);
        continue;
      }
      const it = document.createElement("div");
      it.className = "menu-item-drop";
      const labelEl = document.createElement("span");
      labelEl.className = "menu-label";
      labelEl.textContent = label === langMark ? "✓ " + t(label) : t(label);
      it.appendChild(labelEl);
      if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "menu-hint";
        hintEl.textContent = fmtHint(hint);
        it.appendChild(hintEl);
      }
      it.addEventListener("click", () => {
        this.closeMenus();
        fn();
      });
      menu.appendChild(it);
    }
    document.body.appendChild(menu);
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${y}px`;
    menu.dataset.menuOpen = "1";
  }

  private closeMenus() {
    document.querySelectorAll(".dropdown-menu").forEach((m) => m.remove());
  }

  private alert(msg: string) {
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal"><div class="modal-title">${t("提示")}</div><div class="modal-body">${msg.replace(/\n/g, "<br/>")}</div><div class="modal-actions"><button class="primary modal-ok">${t("确定")}</button></div></div>`;
    modal.querySelector(".modal-ok")!.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  }

  // ---------------------------------------------------------------- update

  private async checkForUpdate() {
    try {
      const update = await checkForUpdate();
      if (!update) {
        this.alert(t("update.none"));
        return;
      }
      const ok = await this.confirmUpdate(t("update.found", { version: update.version }));
      if (!ok) return;
      this.alert(t("update.downloading"));
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      this.alert(t("update.error") + "\n" + String(e));
    }
  }

  private confirmUpdate(msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "modal-mask";
      modal.innerHTML = `<div class="modal"><div class="modal-title">${t("检查更新…")}</div><div class="modal-body">${msg.replace(/\n/g, "<br/>")}</div><div class="modal-actions"><button data-act="ok" class="primary">${t("确定")}</button><button data-act="cancel">${t("取消")}</button></div></div>`;
      modal.querySelector('[data-act="ok"]')!.addEventListener("click", () => { modal.remove(); resolve(true); });
      modal.querySelector('[data-act="cancel"]')!.addEventListener("click", () => { modal.remove(); resolve(false); });
      document.body.appendChild(modal);
    });
  }

  private confirmDirty(doc: Document): Promise<"save" | "discard" | "cancel"> {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "modal-mask";
      modal.innerHTML = `<div class="modal"><div class="modal-title">${t("保存更改？")}</div><div class="modal-body">${t("file.unsaved", { name: doc.name }).replace(/\n/g, "<br/>")}</div><div class="modal-actions"><button data-act="save" class="primary">${t("保存")}</button><button data-act="discard">${t("不保存")}</button><button data-act="cancel">${t("取消")}</button></div></div>`;
      modal.querySelector('[data-act="save"]')!.addEventListener("click", () => { modal.remove(); resolve("save"); });
      modal.querySelector('[data-act="discard"]')!.addEventListener("click", () => { modal.remove(); resolve("discard"); });
      modal.querySelector('[data-act="cancel"]')!.addEventListener("click", () => { modal.remove(); resolve("cancel"); });
      document.body.appendChild(modal);
    });
  }

  // ---------------------------------------------------------------- toolbar

  private bindToolbar() {
    document.getElementById("toolbar")!.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!btn) return;
      const act = btn.dataset.action;
      this.runAction(act!);
    });
    document.getElementById("empty-state")!.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!btn) return;
      const path = btn.dataset.path;
      if (path) {
        this.openFile(path);
        return;
      }
      this.runAction(btn.dataset.action!);
    });
  }

  private runAction(act: string) {
    switch (act) {
      case "new": this.newDoc(); break;
      case "open": this.openDialog(); break;
      case "open-folder": this.openFolderDialog(); break;
      case "save": this.save(false); break;
      case "saveAs": this.save(true); break;
      case "undo": this.exec("undo"); break;
      case "redo": this.exec("redo"); break;
      case "find": this.find.open(); break;
      case "replace": this.find.open({ replace: true }); break;
      case "goto": this.gotoLineDialog(); break;
      case "closeTab": if (this.active) this.closeTab(this.active.id); break;
      case "column": this.toggleColumn(); break;
      case "mode": this.toggleMode(); break;
      case "palette": this.openPalette(); break;
      case "split": this.toggleSplit(); break;
      case "print": this.printActive(); break;
      case "cliphist": this.openClipHist(); break;
      case "tree": this.toggleSidebar(); break;
      case "sidebar": this.toggleSidebar(); break;
      case "theme": this.toggleTheme(); break;
    }
  }

  private exec(cmd: string) {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc) return;
    if (doc.mode === "hex") return;
    const state = v.state;
    if (cmd === "undo") undo(v);
    else if (cmd === "redo") redo(v);
    else if (cmd === "selectAll") v.dispatch({ selection: { anchor: 0, head: state.doc.length } });
    else if (cmd === "cut") this.execDoc("cut");
    else if (cmd === "copy") this.execDoc("copy");
    else if (cmd === "paste") this.execDoc("paste");
    else if (cmd === "findNext") {
      if (this.find.isOpen()) findNext(v);
      else this.find.open();
    } else if (cmd === "findPrev") {
      if (this.find.isOpen()) findPrevious(v);
      else this.find.open();
    } else if (cmd === "selectMatches") selectMatches(v);
  }

  private execDoc(cmd: string) {
    const el = document.createElement("textarea");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    if (cmd === "copy") {
      const text = this.view?.state.selection.main
        ? this.view.state.sliceDoc(this.view.state.selection.main.from, this.view.state.selection.main.to)
        : "";
      el.value = text;
      el.select();
      document.execCommand("copy");
    } else if (cmd === "cut") {
      const text = this.view?.state.sliceDoc(this.view.state.selection.main.from, this.view.state.selection.main.to) ?? "";
      el.value = text;
      el.select();
      document.execCommand("copy");
      if (this.view) {
        this.view.dispatch(this.view.state.replaceSelection(""));
      }
    } else if (cmd === "paste") {
      el.focus();
      document.execCommand("paste");
      const pasted = el.value;
      if (pasted && this.view) {
        this.view.dispatch(this.view.state.replaceSelection(pasted));
      }
    }
    el.remove();
    this.view?.focus();
  }

  private execCmd(fn: (v: EditorView) => boolean) {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    fn(v);
    this.updateStatus();
  }

  private openClipHist() {
    const v = this.view;
    if (!v) return;
    openClipHistory(v, (m) => { this.statusEls.pos.textContent = m; });
  }

  private convertLE(sep: LineEnding) {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    if (convertLineEndings(v, doc, sep)) {
      this.updateStatus();
    } else {
      this.alert(t("行尾已是 ") + lineEndingLabel(sep));
    }
  }

  private encodingOptions(): Array<[string, string]> {
    return [
      ["utf-8", t("UTF-8 无 BOM")],
      ["utf-8-bom", t("UTF-8 带 BOM")],
      ["utf-16le", t("UTF-16 LE")],
      ["utf-16be", t("UTF-16 BE")],
      ["gbk", t("GBK（简体中文）")],
      ["gb18030", t("GB18030")],
      ["big5", t("Big5（繁体中文）")],
      ["shift_jis", t("Shift-JIS（日文）")],
      ["windows-1252", t("Windows-1252（西欧）")],
    ];
  }

  private encodingDialog() {
    const doc = this.active;
    if (!doc || doc.mode === "hex") return;
    const encs = this.encodingOptions();
    const opts = encs.map(([v, l]) => `<option value="${v}" ${v === doc.encoding ? "selected" : ""}>${l}</option>`).join("");
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:360px;"><div class="modal-title">${t("编码转换")}</div><div class="modal-body">
      ${t("当前编码：")}${doc.encoding}<br/><br/>
      ${t("目标编码：")}
      <select id="enc-sel" style="margin-left:6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 8px;">${opts}</select>
      <div class="modal-actions" style="margin-top:14px;">
        <button data-act="set" class="primary">${t("应用（下次保存生效）")}</button>
        <button data-act="saveas">${t("另存为…")}</button>
        <button data-act="cancel">${t("取消")}</button>
      </div>
    </div></div>`;
    const val = () => (modal.querySelector("#enc-sel") as HTMLSelectElement).value;
    modal.querySelector('[data-act="set"]')!.addEventListener("click", () => {
      doc.encoding = val();
      modal.remove();
      this.updateStatus();
      this.alert(t("已设置为 {enc}，保存时将按此编码写入。", { enc: doc.encoding }));
    });
    modal.querySelector('[data-act="saveas"]')!.addEventListener("click", async () => {
      doc.encoding = val();
      modal.remove();
      this.updateStatus();
      await this.save(true);
    });
    modal.querySelector('[data-act="cancel"]')!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.remove();
    });
    document.body.appendChild(modal);
  }

  private defaultSearchDir(): string {
    if (this.searchDir) return this.searchDir;
    const doc = this.active;
    if (doc?.path) {
      const idx = doc.path.lastIndexOf("/");
      const idx2 = doc.path.lastIndexOf("\\");
      const cut = Math.max(idx, idx2);
      if (cut > 0) return doc.path.slice(0, cut);
    }
    return "";
  }

  private activeFileDir(): string {
    const doc = this.active;
    if (doc?.path) {
      const idx = doc.path.lastIndexOf("/");
      const idx2 = doc.path.lastIndexOf("\\");
      const cut = Math.max(idx, idx2);
      if (cut > 0) return doc.path.slice(0, cut);
    }
    if (this.searchDir) return this.searchDir;
    return "";
  }

  private async openTerminalHere() {
    const dir = this.activeFileDir();
    if (!dir) {
      this.alert(t("请先打开一个文件，或在侧边栏打开文件夹。"));
      return;
    }
    try {
      await invoke("open_terminal", { dir });
    } catch (e) {
      this.alert(t("打开终端失败：") + e);
    }
  }

  private async exportHtml() {
    const doc = this.active;
    const v = this.view;
    if (!doc || !v || doc.mode === "hex") return;
    const opts = await this.printOptionsDialog();
    if (!opts) return;
    const title = doc.name || "untitled";
    const rawLines = v.state.doc.toString().split("\n");
    const body = rawLines.map((line, i) =>
      `<div class="pl">${opts.lineNumbers ? `<span class="pln">${i + 1}</span>` : ""}<span class="plt">${escapeHtmlFor(line)}</span></div>`).join("\n");
    const html = `<html><head><meta charset="utf-8"/><title>${escapeHtmlFor(title)}</title><style>
      @page { margin: ${opts.margin}mm; ${opts.header ? `@top-center { content: "${opts.header.replace(/"/g, "'")}"; font-size: 9pt; color:#666; }` : ""} }
      body { font-family: Menlo, monospace; font-size: ${opts.font}pt; line-height: 1.4; color:#111; }
      .pl { white-space: pre; }
      .pln { display:inline-block; width: 3em; margin-right:1em; text-align:right; color:#888; user-select:none; -webkit-print-color-adjust: exact; }
    </style></head><body>${body}</body></html>`;
    const baseDir = this.activeFileDir() || (await invoke<string>("home_dir").catch(() => "/tmp"));
    const tmp = `${baseDir}/uec_print_${title.toString().replace(/[^\w.-]+/g, "_")}.html`;
    try {
      await invoke("save_text_file", { path: tmp, text: html, encoding: "utf-8" });
      await openPath(tmp);
    } catch (e) {
      this.alert(t("导出失败：") + `\n${e}`);
    }
  }

  private async exportMarkdown() {
    const doc = this.active;
    const v = this.view;
    if (!doc || !v) return;
    if (doc.mode === "hex") { this.alert(t("十六进制模式不支持导出，请切换回文本模式。")); return; }
    if (!isMarkdownDoc(doc.path, doc.name)) {
      this.alert(t("仅 Markdown 文档支持此导出。"));
      return;
    }
    const title = doc.name || "untitled";
    const src = v.state.doc.toString();
    const body = renderMarkdown(src);
    const css = `
      body { max-width: 860px; margin: 36px auto; padding: 0 20px;
        font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 15px; line-height: 1.7; color: #1f2328; }
      h1,h2,h3,h4 { line-height: 1.3; margin: 1.4em 0 .6em; }
      h1 { border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
      h2 { border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
      code { background: #f3f4fa; padding: .15em .4em; border-radius: 4px; font-family: Menlo, Consolas, monospace; font-size: 90%; }
      pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; }
      pre code { background: none; padding: 0; }
      blockquote { margin: 0; padding: .2em 1em; color: #57606a; border-left: 4px solid #d0d7de; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
      img { max-width: 100%; }
      a { color: #2a7de1; text-decoration: none; }
      @media print { body { margin: 14mm; } }
    `;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
      `<title>${escapeHtmlFor(title)}</title><style>${css}</style></head>` +
      `<body class="markdown-body">${body}</body></html>`;
    const base = (this.activeFileDir() || (await invoke<string>("home_dir").catch(() => "/tmp")));
    const def = `${base}/${title.toString().replace(/\.[^.]+$/, "")}.html`;
    let picked: string | null = null;
    try {
      picked = await dialogSave({ title: t("导出 Markdown 为 HTML"), defaultPath: def });
    } catch { /* ignore */ }
    if (!picked) return;
    try {
      await invoke("save_text_file", { path: picked, text: html, encoding: "utf-8" });
      this.alert(t("已导出：{p}", { p: picked }));
      await openPath(picked);
    } catch (e) {
      this.alert(t("导出失败：") + `\n${e}`);
    }
  }

  private async exportWord() {
    const doc = this.active;
    const v = this.view;
    if (!doc || !v) return;
    if (doc.mode === "hex") { this.alert(t("十六进制模式不支持导出，请切换回文本模式。")); return; }
    if (!isMarkdownDoc(doc.path, doc.name)) {
      this.alert(t("仅 Markdown 文档支持此导出。"));
      return;
    }
    const title = doc.name || "untitled";
    const src = v.state.doc.toString();
    const body = renderMarkdown(src);
    const css = `
      body { max-width: 860px; margin: 36px auto; padding: 0 20px;
        font-family: "Calibri", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 15px; line-height: 1.7; color: #1f2328; }
      h1,h2,h3,h4 { line-height: 1.3; margin: 1.4em 0 .6em; }
      h1 { border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
      h2 { border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
      code { background: #f3f4fa; padding: .15em .4em; border-radius: 4px; font-family: Menlo, Consolas, monospace; font-size: 90%; }
      pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; }
      pre code { background: none; padding: 0; }
      blockquote { margin: 0; padding: .2em 1em; color: #57606a; border-left: 4px solid #d0d7de; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
      img { max-width: 100%; }
      a { color: #2a7de1; text-decoration: none; }
    `;
    const wordHead = `<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->`;
    const html = `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml" lang="zh-CN"><head>
      <meta charset="utf-8"/>
      <meta name="ProgId" content="Word.Document"/>
      <meta name="Generator" content="Microsoft Word 15"/>
      <title>${escapeHtmlFor(title)}</title>
      <style>${css}</style>${wordHead}</head>
      <body class="markdown-body">${body}</body></html>`;
    const base = (this.activeFileDir() || (await invoke<string>("home_dir").catch(() => "/tmp")));
    const def = `${base}/${title.toString().replace(/\.[^.]+$/, "")}.doc`;
    let picked: string | null = null;
    try {
      picked = await dialogSave({ title: t("导出 Word 为"), defaultPath: def });
    } catch { /* ignore */ }
    if (!picked) return;
    try {
      await invoke("save_text_file", { path: picked, text: html, encoding: "utf-8" });
      this.alert(t("已导出：{p}", { p: picked }));
      await openPath(picked);
    } catch (e) {
      this.alert(t("导出失败：") + `\n${e}`);
    }
  }

  private printActive() {
    const doc = this.active;
    if (!doc) return;
    if (doc.mode === "hex") {       this.alert(t("十六进制模式不支持打印，请切换回文本模式。")); return; }
    if (!this.view) return;
    document.body.setAttribute("data-printing", "editor");
    const cleanup = () => document.body.removeAttribute("data-printing");
    if ((window as any).matchMedia) {
      (window as any).matchMedia("print").addListener((m: any) => { if (!m.matches) cleanup(); });
    }
    (window as any).onafterprint = cleanup;
    setTimeout(() => window.print(), 50);
  }

  private openDocRefs(): DiffDocRef[] {
    return this.tabOrder.map((id) => {
      const d = this.docs.get(id)!;
      return {
        name: d.name,
        path: d.path,
        read: () => d.state?.doc.toString() ?? "",
        applyHunk: (startLine: number, endLine: number, insertText: string) => {
          if (!d.state) return;
          const doc = d.state.doc;
          const from = startLine < doc.lines ? doc.line(startLine + 1).from : doc.length;
          const to = endLine < doc.lines ? doc.line(endLine + 1).from : doc.length;
          let insert = insertText;
          if (insert.length > 0 && to < doc.length) insert += "\n";
          const next = d.state.update({ changes: { from, to, insert } }).state;
          d.state = next;
          d.dirty = true;
          this.updateTabDot(d);
          if (this.activeId === id && this.view) this.view.setState(next);
        },
      };
    });
  }

  private printOptionsDialog(): Promise<{ lineNumbers: boolean; header: string; margin: number; font: number } | null> {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "modal-mask";
      modal.innerHTML = `<div class="modal" style="min-width:360px;"><div class="modal-title">${t("打印 / 导出 PDF")}</div><div class="modal-body">
        <div class="sort-opt"><label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" id="pp-ln" checked/>${t("显示行号")}</label></div>
        <div class="sort-opt">${t("页眉文字")} <input class="fs-input" id="pp-head" placeholder="${t("可选")}" spellcheck="false" style="flex:1;width:auto;"/></div>
        <div class="sort-opt">${t("页边距(mm)")} <input class="fs-input" id="pp-mar" type="number" value="15" style="width:70px;"/></div>
        <div class="sort-opt">${t("字号(pt)")} <input class="fs-input" id="pp-font" type="number" value="10" style="width:70px;"/></div>
        <div class="modal-body" style="color:var(--fg-dim);font-size:12px;">${t("将生成本地 HTML 并用系统浏览器打开，可在打印对话框中另存为 PDF。")}</div>
        <div class="modal-actions" style="margin-top:12px;"><button data-ok class="primary">${t("生成")}</button><button data-cancel>${t("取消")}</button></div>
      </div></div>`;
      const ok = () => {
        resolve({
          lineNumbers: (modal.querySelector("#pp-ln") as HTMLInputElement).checked,
          header: (modal.querySelector("#pp-head") as HTMLInputElement).value.trim(),
          margin: parseInt((modal.querySelector("#pp-mar") as HTMLInputElement).value || "15", 10),
          font: parseInt((modal.querySelector("#pp-font") as HTMLInputElement).value || "10", 10),
        });
        modal.remove();
      };
    modal.querySelector("[data-ok]")!.addEventListener("click", ok);
      modal.querySelector("[data-cancel]")!.addEventListener("click", () => { resolve(null); modal.remove(); });
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { resolve(null); modal.remove(); }
      });
      document.body.appendChild(modal);
    });
  }

  private loadSettings() {
    try {
      const vars = localStorage.getItem("uec.theme.vars");
      if (vars) {
        const data = JSON.parse(vars);
        const apply = (sel: string, v: Record<string, string>) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el && v) for (const [k, val] of Object.entries(v)) if (val) el.style.setProperty(k, val);
        };
        apply(":root", data.light);
        apply("html.dark", data.dark);
      }
      const theme = localStorage.getItem("uec.theme");
      const root = document.documentElement;
      if (theme === "light") root.classList.remove("dark");
      else if (theme === "dark") root.classList.add("dark");
      const font = localStorage.getItem("uec.font");
      if (font) document.documentElement.style.setProperty("--ed-font", font);
      this.prefWrap = localStorage.getItem("uec.wrap") === "1";
      this.prefWs = localStorage.getItem("uec.showws") === "1";
      this.prefPreview = localStorage.getItem("uec.preview") === "1";
    } catch {
      /* ignore */
    }
  }

  private themeVars(): { light: Record<string, string>; dark: Record<string, string> } {
    const pick = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      const names = ["--bg", "--bg2", "--bg3", "--fg", "--fg-dim", "--border", "--accent", "--ed-bg", "--ed-fg", "--ed-gutter", "--ed-line-num", "--ed-line-num-active", "--ed-active-line", "--ed-sel", "--ed-bracket", "--ed-search-match", "--ed-search-match-sel", "--ed-font", "--hex-cell", "--hex-changed", "--hex-ascii", "--hex-sel", "--hex-sel-border"];
      const out: Record<string, string> = {};
      for (const n of names) out[n] = cs.getPropertyValue(n).trim();
      return out;
    };
    return {
      light: pick(document.querySelector(":root") as HTMLElement),
      dark: pick(document.querySelector("html.dark") as HTMLElement),
    };
  }

  private async themeExport() {
    const data = JSON.stringify(this.themeVars(), null, 2);
    const picked = await dialogSave({ title: "导出主题", defaultPath: "theme.json" });
    if (!picked) return;
    try {
      await invoke("save_text_file", { path: picked, text: data, encoding: "utf-8" });
      this.alert(t("主题已导出。"));
    } catch (e) {
      this.alert(t("导出失败：") + `\n${e}`);
    }
  }

  private async themeImport() {
    const picked = await dialogOpen({ multiple: false, title: "导入主题" });
    if (!picked) return;
    try {
      const res = await invoke<{ text: string }>("read_text_file", { path: picked });
      const data = JSON.parse(res.text);
      const apply = (sel: string, vars: Record<string, string>) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el || !vars) return;
        for (const [k, v] of Object.entries(vars)) {
          if (v) el.style.setProperty(k, v);
        }
      };
      apply(":root", data.light);
      apply("html.dark", data.dark);
      localStorage.setItem("uec.theme.vars", JSON.stringify(data));
      this.view?.requestMeasure();
      this.alert(t("主题已应用，重启后依然保留。"));
    } catch (e) {
      this.alert(t("导入失败：") + `\n${e}`);
    }
  }

  private settingsDialog() {
    const root = document.documentElement;
    const curFont = localStorage.getItem("uec.font") || "13px";
    const curTheme = root.classList.contains("dark") ? "dark" : "light";
    const rows = [
      ["新建", "new", "n"], ["打开", "open", "o"], ["保存", "save", "s"], ["另存为", "saveAs", "s"],
      ["查找", "find", "f"], ["替换", "replace", "f"], ["跳转行", "goto", "g"], ["关闭标签", "closeTab", "w"],
      ["侧边栏", "sidebar", "b"], ["列模式", "column", "l"], ["命令面板", "palette", "p"],
      ["拆分窗口", "split", "\\"], ["打印", "print", "p"], ["剪贴板历史", "cliphist", "v"], ["文本/十六进制", "mode", "m"],
    ].map(([label, act, defKey]) => {
      const cur = this.shortcutBinding(act as string) ?? { key: defKey as string, shift: false };
      return `<div class="sort-opt" style="margin:3px 0;">${t(label as string)}
        <input class="fs-input" data-shkey="${act}" value="${cur.key === "\\" ? "\\\\" : cur.key}" maxlength="1" style="width:42px;"/>
        <label style="display:flex;align-items:center;gap:3px;"><input type="checkbox" data-shshift="${act}" ${cur.shift ? "checked" : ""}/>Shift</label>
      </div>`;
    }).join("");
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:420px;max-height:86vh;overflow:auto;"><div class="modal-title">${t("设置")}</div><div class="modal-body">
      <div class="sort-opt" style="margin-bottom:10px;">${t("编辑器字号：")} <input id="set-font" type="number" min="8" max="28" value="${parseInt(curFont, 10)}" style="width:64px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);"/> px</div>
      <div class="sort-opt" style="margin-bottom:10px;">${t("主题：")}
        <select id="set-theme" style="background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:3px 6px;">
          <option value="dark" ${curTheme === "dark" ? "selected" : ""}>${t("深色")}</option>
          <option value="light" ${curTheme === "light" ? "selected" : ""}>${t("浅色")}</option>
        </select>
      </div>
      <div class="fs-options" style="margin:8px 0;">
        <button class="search-btn" data-theme-export>${t("导出主题…")}</button>
        <button class="search-btn" data-theme-import>${t("导入主题…")}</button>
      </div>
       <div style="margin:10px 0 4px;font-weight:600;">${t("编辑器偏好")}</div>
       <div class="sort-opt" style="margin-bottom:8px;"><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-wrap" ${this.prefWrap ? "checked" : ""}/>${t("自动换行")}</label></div>
       <div class="sort-opt" style="margin-bottom:8px;"><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-ws" ${this.prefWs ? "checked" : ""}/>${t("显示空白字符")}</label></div>
       <div class="sort-opt" style="margin-bottom:8px;"><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="set-pv" ${this.prefPreview ? "checked" : ""}/>${t("Markdown 预览默认开启")}</label></div>
       <div style="margin:10px 0 4px;font-weight:600;">${t("快捷键（{m} + 键 + 可选 Shift）", { m: MOD_SYM })}</div>
        ${rows}
      <div class="modal-actions" style="margin-top:14px;"><button data-ok class="primary">${t("确定")}</button><button data-cancel>${t("取消")}</button></div>
    </div></div>`;
    const ok = () => {
      const fontSize = parseInt((modal.querySelector("#set-font") as HTMLInputElement).value, 10);
      const theme = (modal.querySelector("#set-theme") as HTMLSelectElement).value;
      const font = Number.isNaN(fontSize) ? 13 : Math.max(8, Math.min(28, fontSize));
      document.documentElement.style.setProperty("--ed-font", `${font}px`);
      localStorage.setItem("uec.font", `${font}px`);
      this.setWrap((modal.querySelector("#set-wrap") as HTMLInputElement).checked);
      this.setWhitespace((modal.querySelector("#set-ws") as HTMLInputElement).checked);
      this.setPrefPreview((modal.querySelector("#set-pv") as HTMLInputElement).checked);
      root.classList.toggle("dark", theme === "dark");
      localStorage.setItem("uec.theme", theme);
      const keys: Record<string, { key: string; shift: boolean }> = {};
      modal.querySelectorAll("[data-shkey]").forEach((el) => {
        const act = (el as HTMLInputElement).dataset.shkey!;
        const key = (el as HTMLInputElement).value.trim().toLowerCase().charAt(0) || "";
        if (!key) return;
        const shift = (modal.querySelector<HTMLInputElement>(`[data-shshift="${act}"]`)?.checked) ?? false;
        keys[act] = { key, shift };
      });
      localStorage.setItem("uec.keys", JSON.stringify(keys));
      modal.remove();
      this.view?.requestMeasure();
    };
    modal.querySelector("[data-theme-export]")!.addEventListener("click", async (e) => {
      (e.target as HTMLElement).textContent = t("导出中…");
      await this.themeExport();
      (e.target as HTMLElement).textContent = t("导出主题…");
    });
    modal.querySelector("[data-theme-import]")!.addEventListener("click", async (e) => {
      (e.target as HTMLElement).textContent = t("导入中…");
      await this.themeImport();
      (e.target as HTMLElement).textContent = t("导入主题…");
    });
    modal.querySelector("[data-ok]")!.addEventListener("click", ok);
    modal.querySelector("[data-cancel]")!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.remove();
    });
    document.body.appendChild(modal);
  }

  async openFileAtLine(path: string, line: number) {
    await this.openFile(path);
    const doc = this.active;
    const v = this.view;
    if (!doc || !v || doc.mode === "hex") return;
    const l = Math.max(1, Math.min(line, v.state.doc.lines));
    const ln = v.state.doc.line(l);
    v.dispatch({
      selection: { anchor: ln.from },
      effects: [EditorView.scrollIntoView(ln.from, { y: "center" })],
    });
  }

  private async openRemoteDoc(tmp: string, proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string) {
    let res;
    try {
      res = await invoke<{ text: string; truncated: boolean; encoding: string; is_binary: boolean; size: number }>("read_text_file", { path: tmp });
    } catch (e) {
      this.alert(t("打开失败：") + `\n${e}`);
      return;
    }
    const name = remotePath.split("/").pop() || remotePath;
    const doc: Document = {
      id: uid(),
      path: tmp,
      name: `${name} [${proto.toUpperCase()}]`,
      encoding: res.encoding,
      lineEnding: "lf",
      isBinary: res.is_binary,
      mode: "text",
      dirty: false,
      size: res.size,
      truncated: res.truncated,
      remote: { proto, id, path: remotePath },
    };
    if (!res.is_binary) {
      doc.state = EditorState.create({ doc: res.text, extensions: this.extForDoc(doc) });
    }
    this.addDoc(doc);
  }

  private openFileSearch(replace: boolean) {
    this.fileSearch.open(this.defaultSearchDir(), replace);
  }

  private commandRegistry(): CommandEntry[] {
    const c = (label: string, category: string, run: () => void): CommandEntry => ({ id: label, label, category, run });
    const items: CommandEntry[] = [
      c("新建文件", "文件", () => this.newDoc()),
      c("打开文件…", "文件", () => this.openDialog()),
      c("打开文件夹…", "文件", () => this.openFolderDialog()),
      c("保存", "文件", () => this.save(false)),
      c("另存为…", "文件", () => this.save(true)),
      c("关闭标签", "文件", () => this.active && this.closeTab(this.active.id)),
      c("新窗口", "文件", () => invoke("new_window").catch((e) => this.alert(t("无法打开新窗口：") + `\n${e}`))),
      c("导出为 HTML", "文件", () => this.exportHtml()),
      c("导出 Markdown", "文件", () => this.exportMarkdown()),
      c("导出 Word", "文件", () => this.exportWord()),
      c("打印…", "文件", () => this.printActive()),
      c("编码转换…", "文件", () => this.encodingDialog()),
      c("查找…", "查找", () => this.find.open()),
      c("替换…", "查找", () => this.find.open({ replace: true })),
      c("查找下一个", "查找", () => this.exec("findNext")),
      c("查找上一个", "查找", () => this.exec("findPrev")),
      c("在文件中查找…", "查找", () => this.openFileSearch(false)),
      c("在文件中替换…", "查找", () => this.openFileSearch(true)),
      c("跳转到行…", "转到", () => this.gotoLineDialog()),
      c("设置/取消书签", "转到", () => this.execCmd(toggleBookmark)),
      c("下一个书签", "转到", () => this.execCmd(nextBookmark)),
      c("上一个书签", "转到", () => this.execCmd(prevBookmark)),
      c("上一个编辑位置", "转到", () => this.execCmd(jumpBack)),
      c("下一个编辑位置", "转到", () => this.execCmd(jumpForward)),
      c("列编辑模式", "编辑", () => this.toggleColumn()),
      c("注释/取消注释", "编辑", () => this.execCmd(toggleComment)),
      c("录制/停止宏", "宏", () => this.execCmd(toggleRecordMacro)),
      c("播放宏", "宏", () => this.execCmd(runMacro)),
      c("宏管理…", "宏", () => { const v = this.view; if (v) macroManagerDialog(v, (m) => { this.statusEls.pos.textContent = m; }); }),
      c("代码片段…", "工具", () => snippetManagerDialog()),
      c("剪贴板历史…", "编辑", () => this.openClipHist()),
      c("行排序…", "编辑", () => this.sortDialog()),
      c("插入数字序列…", "编辑", () => this.numSeqDialog()),
      c("大写", "编辑", () => this.execCmd(upperCaseCmd)),
      c("小写", "编辑", () => this.execCmd(lowerCaseCmd)),
      c("首字母大写", "编辑", () => this.execCmd(titleCaseSelection)),
      c("JSON 格式化", "工具", () => this.applyTool(formatJson)),
      c("JSON 压缩", "工具", () => this.applyTool(minifyJson)),
      c("HTML 格式化", "工具", () => this.applyTool(formatHtml)),
      c("XML 格式化", "工具", () => this.applyTool(formatXml)),
      c("Base64 编码", "工具", () => this.applyTool(base64Encode)),
      c("Base64 解码", "工具", () => this.applyTool(base64Decode)),
      c("URL 编码", "工具", () => this.applyTool(urlEncode)),
      c("URL 解码", "工具", () => this.applyTool(urlDecode)),
      c("字数统计…", "工具", () => this.wordCountDialog()),
      c("拼写检查…", "工具", () => this.openSpellCheck()),
      c("文件比较…", "工具", () => showDiffDialog(this.openDocRefs())),
      c("目录比较/同步…", "工具", () => showDirCompare()),
      c("脚本编辑器…", "工具", () => showScriptDialog()),
      c("在终端中打开", "工具", () => this.openTerminalHere()),
      c("大文件查看/编辑…", "工具", async () => {
        const picked = await dialogOpen({ multiple: false, title: "选择大文件" });
        if (picked) showBigViewer(picked);
      }),
      c("设置…", "设置", () => this.settingsDialog()),
      c("在文件中查找…", "工具", () => this.openFileSearch(false)),
      c("列出所有匹配行…", "查找", () => this.listMatchesInFile()),
      c("删除重复行", "编辑", () => this.deleteDuplicateLines()),
      c("删除空行", "编辑", () => this.deleteBlankLines()),
      c("删除行尾空格", "编辑", () => this.trimTrailingWhitespace()),
      c("压缩连续空行", "编辑", () => this.compressBlankLines()),
      c("硬换行…", "编辑", () => this.rewrapDialog()),
      c("插入日期/时间…", "编辑", () => this.insertDateTimeDialog()),
      c("插入字符/ASCII 表…", "编辑", () => this.charTableDialog()),
      c("转换行尾 (CRLF)", "文件", () => this.convertLE("crlf")),
      c("转换行尾 (LF)", "文件", () => this.convertLE("lf")),
      c("转换行尾 (CR)", "文件", () => this.convertLE("cr")),
      c("自动换行", "视图", () => this.toggleWrap()),
      c("显示空白字符", "视图", () => this.toggleWhitespace()),
      c("拆分/合并窗口", "视图", () => this.toggleSplit()),
      c(this.previewOn ? t("关闭预览") : t("Markdown 预览"), "视图", () => this.togglePreview()),
      c("切换侧边栏", "视图", () => this.toggleSidebar()),
      c("切换主题", "视图", () => this.toggleTheme()),
      c("切换文本/十六进制", "视图", () => this.toggleMode()),
      c("标签列表…", "视图", () => this.showTabList()),
    ];
    return items;
  }

  private openPalette() {
    this.palette.open(this.commandRegistry());
  }

  private gotoLineDialog() {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    const total = v.state.doc.lines;
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal"><div class="modal-title">${t("跳转到行")}</div><div class="modal-body">${t("行号（1 - {n}）：", { n: total })} <input id="goto-input" type="number" min="1" max="${total}" style="width:90px;margin-left:4px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);"/><div class="modal-actions" style="margin-top:12px;"><button data-act="ok" class="primary">${t("跳转")}</button><button data-act="cancel">${t("取消")}</button></div></div></div>`;
    const input = modal.querySelector<HTMLInputElement>("#goto-input")!;
    const ok = () => {
      const n = parseInt(input.value, 10);
      modal.remove();
      if (Number.isNaN(n) || n < 1 || n > total) return;
      const line = v.state.doc.line(n);
      v.dispatch({
        selection: { anchor: line.from },
        effects: [EditorView.scrollIntoView(line.from, { y: "center" })],
      });
      v.focus();
      this.updateStatus();
    };
    modal.querySelector('[data-act="ok"]')!.addEventListener("click", ok);
    modal.querySelector('[data-act="cancel"]')!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok();
      if (e.key === "Escape") modal.remove();
    });
    document.body.appendChild(modal);
    input.focus();
    input.select();
  }

  private numSeqDialog() {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex" || v.state.selection.main.empty) {
      this.alert(t("请先用鼠标选择多行（可配合列模式）后再插入数字序列。"));
      return;
    }
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:340px;"><div class="modal-title">${t("插入数字序列")}</div><div class="modal-body">
      <div class="sort-opt">${t("起始值")} <input id="ns-start" class="fs-input" type="number" value="1" style="width:70px;"/></div>
      <div class="sort-opt">${t("步长")} <input id="ns-step" class="fs-input" type="number" value="1" style="width:70px;"/></div>
      <div class="sort-opt">${t("最小位数")} <input id="ns-pad" class="fs-input" type="number" value="0" style="width:70px;"/>${t("（0=不补零）")}</div>
      <div class="fs-row"><input id="ns-pre" class="fs-input" placeholder="${t("前缀（可选）")}"/><input id="ns-suf" class="fs-input" placeholder="${t("后缀（可选）")}"/></div>
      <div class="modal-actions" style="margin-top:12px;"><button data-ok class="primary">${t("插入")}</button><button data-cancel>${t("取消")}</button></div>
    </div></div>`;
    const ok = () => {
      const start = parseInt((modal.querySelector("#ns-start") as HTMLInputElement).value || "0", 10);
      const step = parseInt((modal.querySelector("#ns-step") as HTMLInputElement).value || "1", 10);
      const pad = parseInt((modal.querySelector("#ns-pad") as HTMLInputElement).value || "0", 10);
      const prefix = (modal.querySelector("#ns-pre") as HTMLInputElement).value;
      const suffix = (modal.querySelector("#ns-suf") as HTMLInputElement).value;
      modal.remove();
      insertNumberSequence(v, { start, step, pad, prefix, suffix });
      v.focus();
    };
    modal.querySelector("[data-ok]")!.addEventListener("click", ok);
    modal.querySelector("[data-cancel]")!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok();
      if (e.key === "Escape") modal.remove();
    });
    document.body.appendChild(modal);
  }

  private sortDialog() {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal"><div class="modal-title">${t("行排序")}</div><div class="modal-body">
      <label class="sort-opt"><input type="radio" name="sort-dir" value="asc" checked/>${t("升序")}</label>
      <label class="sort-opt"><input type="radio" name="sort-dir" value="desc"/>${t("降序")}</label>
      <div style="margin-top:10px;">
        <label class="sort-opt"><input type="radio" name="sort-mode" value="text" checked/>${t("按文本")}</label>
        <label class="sort-opt"><input type="radio" name="sort-mode" value="num"/>${t("按数字")}</label>
      </div>
      <label class="sort-opt" style="margin-top:10px;display:block;"><input type="checkbox" id="sort-case"/>${t("区分大小写")}</label>
      <label class="sort-opt" style="margin-top:6px;display:block;"><input type="checkbox" id="sort-dedupe"/>${t("去重（删除重复行）")}</label>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
        <span style="color:var(--fg-dim);">${t("按列范围排序（可选）：")}</span>
        <label>${t("起")}<input id="sort-cs" type="number" min="1" style="width:60px;margin:0 4px;padding:2px 4px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;"/></label>
        <label>${t("止")}<input id="sort-ce" type="number" min="1" style="width:60px;margin:0 4px;padding:2px 4px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;"/></label>
      </div>
      <div class="modal-actions" style="margin-top:12px;"><button data-act="ok" class="primary">${t("排序")}</button><button data-act="cancel">${t("取消")}</button></div>
    </div></div>`;
    const ok = () => {
      const dir = modal.querySelector<HTMLInputElement>('input[name="sort-dir"]:checked')!.value;
      const mode = modal.querySelector<HTMLInputElement>('input[name="sort-mode"]:checked')!.value;
      const cas = modal.querySelector<HTMLInputElement>("#sort-case")!.checked;
      const dedupe = modal.querySelector<HTMLInputElement>("#sort-dedupe")!.checked;
      const colStart = parseInt(modal.querySelector<HTMLInputElement>("#sort-cs")!.value || "0", 10) || 0;
      const colEnd = parseInt(modal.querySelector<HTMLInputElement>("#sort-ce")!.value || "0", 10) || 0;
      modal.remove();
      sortSelection(v, { desc: dir === "desc", numeric: mode === "num", caseSensitive: cas, dedupe, colStart, colEnd });
      v.focus();
    };
    modal.querySelector('[data-act="ok"]')!.addEventListener("click", ok);
    modal.querySelector('[data-act="cancel"]')!.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  }

  private toggleColumn() {
    const doc = this.active;
    if (!doc || doc.mode === "hex") return;
    const v = this.view;
    if (!v) return;
    const next = !isColumnMode();
    setColumnMode(next);
    this.updateColumnButton();
    if (next) this.statusEls.pos.textContent = t("列编辑模式已开启");
  }

  private setWrap(on: boolean) {
    this.prefWrap = on;
    try { localStorage.setItem("uec.wrap", on ? "1" : "0"); } catch { /* ignore */ }
    const doc = this.active;
    if (doc) doc.wrap = on;
    if (this.view && doc?.mode !== "hex") {
      this.view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
    }
  }

  private setWhitespace(on: boolean) {
    this.prefWs = on;
    try { localStorage.setItem("uec.showws", on ? "1" : "0"); } catch { /* ignore */ }
    const doc = this.active;
    if (doc) doc.showWs = on;
    if (this.view && doc?.mode !== "hex") {
      this.view.dispatch({ effects: wsCompartment.reconfigure(on ? [highlightWhitespace()] : []) });
    }
  }

  private setPrefPreview(on: boolean) {
    this.prefPreview = on;
    try { localStorage.setItem("uec.preview", on ? "1" : "0"); } catch { /* ignore */ }
  }

  private toggleWrap() {
    if (this.active?.mode === "hex") return;
    this.setWrap(!this.prefWrap);
    this.view?.focus();
  }

  private toggleWhitespace() {
    if (this.active?.mode === "hex") return;
    this.setWhitespace(!this.prefWs);
    this.view?.focus();
  }

  // ---- line cleanup + hard wrap ----

  private transformSelectedLines(fn: (lines: string[]) => string[]) {
    const v = this.view;
    if (!v) return;
    const doc = v.state.doc;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : Math.min(sel.from, sel.to);
    const to = sel.empty ? doc.length : Math.max(sel.from, sel.to);
    const startNo = doc.lineAt(from).number;
    let endNo = doc.lineAt(to <= from ? from : to - 1).number;
    if (to <= doc.line(endNo).from) endNo = Math.max(startNo, endNo - 1);
    const startLine = doc.line(startNo);
    const endLine = doc.line(endNo);
    const texts: string[] = [];
    for (let n = startNo; n <= endNo; n++) texts.push(doc.line(n).text);
    const out = fn(texts);
    let insert = out.join("\n");
    const includeTrailingNl = endNo < doc.lines;
    if (includeTrailingNl) insert += "\n";
    v.dispatch({
      changes: { from: startLine.from, to: endLine.to + (includeTrailingNl ? 1 : 0), insert },
      selection: { anchor: startLine.from },
    });
    v.focus();
  }

  private deleteDuplicateLines() {
    const seen = new Set<string>();
    this.transformSelectedLines((lines) => lines.filter((l) => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    }));
  }

  private deleteBlankLines() {
    this.transformSelectedLines((lines) => lines.filter((l) => l.trim().length > 0));
  }

  private trimTrailingWhitespace() {
    this.transformSelectedLines((lines) => lines.map((l) => l.replace(/\s+$/, "")));
  }

  private compressBlankLines() {
    this.transformSelectedLines((lines) => {
      const out: string[] = [];
      let prevBlank = false;
      for (const l of lines) {
        const blank = l.trim().length === 0;
        if (blank && prevBlank) continue;
        out.push(l);
        prevBlank = blank;
      }
      return out;
    });
  }

  private rewrapDialog() {
    const v = this.view;
    if (!v) return;
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `
      <div class="modal" style="min-width:320px;">
        <div class="modal-title">${t("硬换行（按列宽折行）")}</div>
        <div class="modal-body">
          <div class="fs-row"><label style="width:90px;">${t("列宽")}</label><input id="rw-width" class="fs-input" type="number" value="78" min="20" max="500"/></div>
          <div class="fs-row"><label style="width:90px;">${t("合并段落")}</label><input id="rw-join" type="checkbox" checked/></div>
          <div class="fs-row" style="color:var(--fg-dim);font-size:12px;">${t("勾选后按空行分段、段内合并后折行；不勾选则仅对超长行折行。")}</div>
        </div>
        <div class="modal-actions">
          <button class="primary" id="rw-ok">${t("确定")}</button>
          <button id="rw-cancel">${t("取消")}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector("#rw-cancel")!.addEventListener("click", close);
    modal.querySelector("#rw-ok")!.addEventListener("click", () => {
      const width = parseInt((modal.querySelector("#rw-width") as HTMLInputElement).value, 10) || 78;
      const join = (modal.querySelector("#rw-join") as HTMLInputElement).checked;
      this.rewrap(width, join);
      close();
    });
  }

  private rewrap(width: number, join: boolean) {
    const v = this.view;
    if (!v) return;
    const doc = v.state.doc;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : Math.min(sel.from, sel.to);
    const to = sel.empty ? doc.length : Math.max(sel.from, sel.to);
    const startNo = doc.lineAt(from).number;
    let endNo = doc.lineAt(to <= from ? from : to - 1).number;
    if (to <= doc.line(endNo).from) endNo = Math.max(startNo, endNo - 1);
    const startLine = doc.line(startNo);
    const endLine = doc.line(endNo);
    const texts: string[] = [];
    for (let n = startNo; n <= endNo; n++) texts.push(doc.line(n).text);
    const out = rewrapLines(texts, { width, joinParagraphs: join });
    let insert = out.join("\n");
    const includeTrailingNl = endNo < doc.lines;
    if (includeTrailingNl) insert += "\n";
    v.dispatch({
      changes: { from: startLine.from, to: endLine.to + (includeTrailingNl ? 1 : 0), insert },
      selection: { anchor: startLine.from },
    });
    v.focus();
  }

  // ---- insert date/time + character table ----

  private insertAtCursor(text: string) {
    const v = this.view;
    if (!v) return;
    const sel = v.state.selection.main;
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    v.focus();
  }

  private formatDate(d: Date, pat: string): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return pat
      .replace(/YYYY/g, String(d.getFullYear()))
      .replace(/MM/g, p(d.getMonth() + 1))
      .replace(/DD/g, p(d.getDate()))
      .replace(/HH/g, p(d.getHours()))
      .replace(/mm/g, p(d.getMinutes()))
      .replace(/SS/g, p(d.getSeconds()));
  }

  private insertDateTimeDialog() {
    const v = this.view;
    if (!v) return;
    const presets = [
      "YYYY-MM-DD",
      "YYYY-MM-DD HH:mm:ss",
      "YYYY/MM/DD",
      "MM-DD-YYYY",
      "HH:mm:ss",
      "YYYY年MM月DD日",
    ];
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `
      <div class="modal" style="min-width:340px;">
        <div class="modal-title">${t("插入日期 / 时间")}</div>
        <div class="modal-body">
          <div id="dt-presets" style="display:flex;flex-direction:column;gap:6px;">
            ${presets.map((f) => `<button class="search-btn dt-preset" data-f="${f}">${this.formatDate(new Date(), f)}  <span style="color:var(--fg-dim);">(${t(f)})</span></button>`).join("")}
          </div>
          <div class="fs-row" style="margin-top:12px;">
            <input id="dt-custom" class="fs-input" placeholder="${t("自定义格式，如 YYYY-MM-DD")}" />
            <button class="search-btn" id="dt-insert">${t("插入")}</button>
          </div>
        </div>
        <div class="modal-actions"><button data-act="close" class="primary">${t("关闭")}</button></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll<HTMLElement>(".dt-preset").forEach((b) => {
      b.addEventListener("click", () => {
        this.insertAtCursor(this.formatDate(new Date(), b.dataset.f!));
        modal.remove();
      });
    });
    modal.querySelector("#dt-insert")!.addEventListener("click", () => {
      const f = (modal.querySelector("#dt-custom") as HTMLInputElement).value.trim();
      if (!f) return;
      this.insertAtCursor(this.formatDate(new Date(), f));
      modal.remove();
    });
    modal.querySelector('[data-act="close"]')!.addEventListener("click", () => modal.remove());
  }

  private charTableDialog() {
    const v = this.view;
    if (!v) return;
    const ascii: string[] = [];
    for (let c = 32; c <= 126; c++) ascii.push(String.fromCharCode(c));
    const symbols = ["•", "◦", "◆", "★", "☆", "►", "◄", "▲", "▼", "→", "←", "↑", "↓", "✓", "✗", "©", "®", "™", "…", "—", "–", "‘", "’", "“", "”", "«", "»", "§", "¶", "€", "£", "¥", "°", "±", "×", "÷", "≠", "≤", "≥", "∞", "∑", "√", "α", "β", "γ", "δ", "λ", "μ", "π", "σ", "φ", "Ω"];
    const grid = (chars: string[]) =>
      chars.map((ch) => `<button class="char-btn" data-ch="${escapeHtmlFor(ch)}" title="U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}">${escapeHtmlFor(ch)}</button>`).join("");
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `
      <div class="modal" style="min-width:460px;">
        <div class="modal-title">${t("插入字符（ASCII / 符号）")}</div>
        <div class="modal-body">
          <div class="char-grid">${grid(ascii)}</div>
          <div style="margin-top:10px;color:var(--fg-dim);font-size:12px;">${t("常用符号")}</div>
          <div class="char-grid">${grid(symbols)}</div>
          <div style="margin-top:10px;color:var(--fg-dim);font-size:12px;">${t("点击字符即插入到光标处（可连续插入），关闭后生效。")}</div>
        </div>
        <div class="modal-actions"><button data-act="close" class="primary">${t("关闭")}</button></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll<HTMLElement>(".char-btn").forEach((b) => {
      b.addEventListener("click", () => this.insertAtCursor(b.dataset.ch || ""));
    });
    modal.querySelector('[data-act="close"]')!.addEventListener("click", () => modal.remove());
  }

  // ---- list all matches in current file ----

  private listMatchesInFile() {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") {
      this.alert(t("请先打开一个文本文件。"));
      return;
    }
    const selText = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `
      <div class="modal" style="min-width:520px;max-width:80vw;">
        <div class="modal-title">${t("列出所有匹配行（当前文件）")}</div>
        <div class="fs-row">
          <input id="lm-query" class="fs-input" placeholder="${t("查找内容...")}" spellcheck="false" value="${selText && selText.length < 200 ? escapeHtmlFor(selText) : ""}"/>
        </div>
        <div class="fs-options">
          <label class="search-opt"><input type="checkbox" id="lm-case"/>${t("区分大小写")}</label>
          <label class="search-opt"><input type="checkbox" id="lm-regex"/>${t("正则")}</label>
          <label class="search-opt"><input type="checkbox" id="lm-word"/>${t("全词")}</label>
          <button class="search-btn" id="lm-run">${t("列出")}</button>
          <button class="search-btn" id="lm-close">${t("关闭")}</button>
        </div>
        <div id="lm-results" class="fs-results"><div class="fs-empty">${t("输入查找内容并点击“列出”")}</div></div>
        <div id="lm-status" class="fs-status"></div>
      </div>`;
    document.body.appendChild(modal);
    const qInput = modal.querySelector<HTMLInputElement>("#lm-query")!;
    const results = modal.querySelector<HTMLElement>("#lm-results")!;
    const status = modal.querySelector<HTMLElement>("#lm-status")!;

    const run = () => {
      const term = qInput.value;
      if (!term) { status.textContent = t("请输入查找内容"); return; }
      const caseSensitive = (modal.querySelector("#lm-case") as HTMLInputElement).checked;
      const regex = (modal.querySelector("#lm-regex") as HTMLInputElement).checked;
      const word = (modal.querySelector("#lm-word") as HTMLInputElement).checked;
      let re: RegExp;
      try {
        const pattern = regex ? term : word ? `\\b${escapeRegExp(term)}\\b` : escapeRegExp(term);
        re = new RegExp(pattern, caseSensitive ? "g" : "gi");
      } catch (e) {
        status.textContent = t("正则错误：") + (e as Error).message;
        return;
      }
      const d = v.state.doc;
      const buckets = new Map<number, { lineNo: number; lineFrom: number; text: string; pos: number; ranges: Array<[number, number]> }>();
      const cur = new RegExpCursor(d, re.source, { ignoreCase: !caseSensitive }, 0, d.length);
      let count = 0;
      while (!cur.next().done) {
        const { from, to } = cur.value;
        count++;
        const ln = d.lineAt(from).number;
        let b = buckets.get(ln);
        if (!b) {
          const line = d.line(ln);
          b = { lineNo: ln, lineFrom: line.from, text: line.text, pos: from, ranges: [] };
          buckets.set(ln, b);
        }
        b.ranges.push([from - b.lineFrom, to - b.lineFrom]);
      }
      const items = [...buckets.values()].sort((a, b) => a.lineNo - b.lineNo);
      if (!items.length) {
        results.innerHTML = `<div class="fs-empty">${t("没有匹配")}</div>`;
        status.textContent = t("共 {lines} 行 / {count} 处", { lines: 0, count: 0 });
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "fs-item";
        row.dataset.pos = String(it.pos);
        row.innerHTML = `<span class="fs-line-no">${it.lineNo}</span><span class="fs-line-text">${highlightRanges(it.text, it.ranges)}</span>`;
        frag.appendChild(row);
      }
      results.innerHTML = "";
      results.appendChild(frag);
      results.querySelectorAll("[data-pos]").forEach((node) => {
        node.addEventListener("click", () => {
          const pos = parseInt((node as HTMLElement).dataset.pos || "0", 10);
          v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
          v.focus();
        });
      });
      status.textContent = t("共 {lines} 行 / {count} 处", { lines: items.length, count });
    };

    modal.querySelector("#lm-run")!.addEventListener("click", run);
    modal.querySelector("#lm-close")!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === qInput) { e.preventDefault(); run(); }
      if (e.key === "Escape") modal.remove();
    });
    qInput.focus();
    qInput.select();
  }

  private splitReadOnlyExt(doc: Document): import("@codemirror/state").Extension[] {
    const lang = doc.path ? langForPath(doc.path) : { ext: [], name: t("纯文本") };
    const base: import("@codemirror/state").Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      syntaxHighlighting(defaultHighlightStyle),
      highlightSelectionMatches(),
      searchHighlight(),
      foldGutter(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      wrapCompartment.of(doc.wrap ? EditorView.lineWrapping : []),
      wsCompartment.of(doc.showWs ? [highlightWhitespace()] : []),
      themeBase(),
    ];
    if (lang.ext) base.push(lang.ext);
    return base;
  }

  private ensureSplitView() {
    if (this.splitView) return;
    this.splitPanel.classList.remove("hidden");
    this.mainPanel.classList.add("split-mode");
    this.splitPanel.innerHTML =
      `<div id="split-head"><span id="split-name"></span>` +
      `<button id="split-close" title="${t("关闭分屏")}">✕</button></div>` +
      `<div id="split-host"></div>`;
    this.splitPanel.querySelector("#split-close")!.addEventListener("click", () => this.toggleSplit());
    const host = this.splitPanel.querySelector("#split-host")!;
    this.splitView = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions: [] }) });
  }

  private renderSplit(doc: Document) {
    if (!this.splitView) return;
    const nameEl = this.splitPanel.querySelector("#split-name");
    if (nameEl) nameEl.textContent = doc.path || doc.name;
    this.splitView.setState(EditorState.create({
      doc: doc.state ? doc.state.doc : "",
      extensions: this.splitReadOnlyExt(doc),
    }));
  }

  private destroySplit() {
    if (this.splitView) { this.splitView.destroy(); this.splitView = null; }
    this.splitDocId = null;
    this.splitPanel.classList.add("hidden");
    this.splitPanel.innerHTML = "";
    this.mainPanel.classList.remove("split-mode");
  }

  private openInSplit(docId: string) {
    const doc = this.docs.get(docId);
    if (!doc || doc.mode === "hex") return;
    this.ensureSplitView();
    this.splitDocId = docId;
    this.renderSplit(doc);
  }

  private toggleSplit() {
    if (this.splitView) {
      this.destroySplit();
      return;
    }
    const doc = this.active;
    if (!doc || doc.mode === "hex") { this.alert(t("十六进制模式不支持分屏，请切换回文本模式。")); return; }
    if (!this.view) return;
    this.ensureSplitView();
    this.splitDocId = doc.id;
    this.renderSplit(doc);
  }

  private togglePreview() {
    if (this.previewOn) {
      this.closePreview();
      return;
    }
    const doc = this.active;
    if (!doc || doc.mode === "hex") {
      this.alert(t("十六进制模式不支持预览，请切换回文本模式。"));
      return;
    }
    if (!isMarkdownDoc(doc.path, doc.name)) {
      this.alert(t("当前文件不是 Markdown，无法预览。"));
      return;
    }
    this.openPreview();
  }

  private openPreview() {
    const view = this.view;
    if (!view) return;
    this.previewPanel.classList.remove("hidden");
    this.preview = new MarkdownPreview(this.previewPanel, t("关闭预览"));
    this.preview.onClose = () => this.closePreview();
    this.preview.attach(view);
    this.previewOn = true;
    this.prefPreview = true;
    try { localStorage.setItem("uec.preview", "1"); } catch { /* ignore */ }
    this.refreshPreview();
  }

  private closePreview() {
    if (this.preview) {
      this.preview.destroy();
      this.preview = null;
    }
    this.previewPanel.classList.add("hidden");
    this.previewOn = false;
    this.prefPreview = false;
    try { localStorage.setItem("uec.preview", "0"); } catch { /* ignore */ }
  }

  private refreshPreview() {
    if (!this.previewOn || !this.preview) return;
    const doc = this.active;
    if (!doc || !isMarkdownDoc(doc.path, doc.name)) {
      this.closePreview();
      return;
    }
    const src = this.view ? this.view.state.doc.toString() : "";
    this.preview.show(src, doc.path || doc.name);
  }

  private schedulePreview() {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.refreshPreview(), 150);
  }

  private toggleAutosave() {
    this.autosave = !this.autosave;
    if (this.autosave) {
      if (this.autosaveTimer == null) {
        this.autosaveTimer = window.setInterval(() => this.autosaveRun(), 3000);
      }
      this.statusEls.pos.textContent = t("自动保存已开启");
    } else {
      if (this.autosaveTimer != null) {
        window.clearInterval(this.autosaveTimer);
        this.autosaveTimer = null;
      }
      this.statusEls.pos.textContent = t("自动保存已关闭");
    }
  }

  private autosaveRun() {
    for (const doc of this.docs.values()) {
      if (!doc.dirty) continue;
      if (doc.path && doc.mode !== "hex") {
        void this.saveDocument(doc);
      } else if (!doc.path && doc.state) {
        void invoke("write_recovery", { key: doc.id, name: doc.name, text: doc.state.doc.toString() }).catch(() => {});
      }
    }
  }

  private async saveDocument(doc: Document): Promise<boolean> {
    if (doc.mode === "hex" || !doc.state) return false;
    try {
      const text = doc.state.doc.toString();
      await invoke("save_text_file", { path: doc.path, text, encoding: doc.encoding, line_ending: doc.lineEnding, backup: true });
      doc.dirty = false;
      doc.size = new TextEncoder().encode(text).length;
      this.updateTabDot(doc);
      await invoke("clear_recovery", { key: doc.id }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  private toggleTabWrap() {
    const bar = document.getElementById("tabbar")!;
    const on = !bar.classList.contains("wrap");
    bar.classList.toggle("wrap", on);
    try {
      localStorage.setItem("uec.tabwrap", on ? "1" : "");
    } catch {
      /* ignore */
    }
  }

  private showTabList() {
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:420px;max-height:70vh;display:flex;flex-direction:column;"><div class="modal-title">标签列表</div><div class="rec-list" id="tl-list" style="flex:1;"></div><div class="modal-actions" style="margin-top:10px;"><button data-close class="primary">关闭</button></div></div>`;
    const body = modal.querySelector("#tl-list")!;
    const render = () => {
      body.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const doc of this.docs.values()) {
        const row = document.createElement("div");
        row.className = "rec-item";
        row.dataset.id = doc.id;
        row.innerHTML = `<span class="rec-name">${escapeHtmlFor(doc.name)}${doc.remote ? ` <span style="color:var(--accent);font-size:11px;">[${doc.remote.proto.toUpperCase()}]</span>` : ""}</span><span class="rec-meta">${doc.dirty ? "● " + t("未保存") : ""}</span>`;
        if (doc.id === this.activeId) row.classList.add("tl-active");
        row.addEventListener("click", () => {
          if (row.dataset.id === this.activeId) {
            modal.remove();
          } else {
            this.activate(row.dataset.id!);
            render();
          }
        });
        frag.appendChild(row);
      }
      body.appendChild(frag);
    };
    modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.remove();
    });
    document.body.appendChild(modal);
    render();
  }

  private closeSplitIfNeeded(id: string) {
    if (this.splitDocId === id) {
      this.destroySplit();
    }
  }

  private applyTool(tool: (t: string) => ToolResult) {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    const sel = v.state.selection.main;
    const whole = sel.empty;
    const text = whole ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to);
    if (!text.trim()) return;
    const res = tool(text);
    if (!res.ok) {
      this.alert(t("操作失败：") + res.error);
      return;
    }
    v.dispatch({
      changes: whole
        ? { from: 0, to: v.state.doc.length, insert: res.text }
        : { from: sel.from, to: sel.to, insert: res.text },
    });
    v.focus();
    this.updateStatus();
  }

  private openSpellCheck() {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    spellCheckDialog(v, (word, replacement) => {
      const text = v.state.doc.toString();
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      const changed = text.replace(re, replacement);
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: changed },
        selection: { anchor: v.state.selection.main.head },
      });
      doc.dirty = true;
      this.updateTabDot(doc);
      this.statusEls.pos.textContent = t('已将 {word} 替换为 {replacement}', { word, replacement });
    });
  }

  private wordCountDialog() {
    const v = this.view;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    const sel = v.state.selection.main;
    const wholeText = v.state.doc.toString();
    const whole = countText(wholeText);
    let selCount: ReturnType<typeof countText> | null = null;
    if (!sel.empty) {
      selCount = countText(v.state.sliceDoc(sel.from, sel.to));
    }
    const fmt = (c: ReturnType<typeof countText>) =>
      t("字符：{chars}　非空白字符：{cns}　单词：{words}　行：{lines}　字节：{bytes}", {
        chars: c.chars, cns: c.charsNoSpace, words: c.words, lines: c.lines, bytes: c.bytes,
      });
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:420px;"><div class="modal-title">${t("字数统计")}</div><div class="modal-body">
      <div style="margin-bottom:8px;font-weight:600;">${t("整个文档")}</div>
      <div class="wc-line">${fmt(whole)}</div>
      ${selCount ? `<div style="margin:10px 0 6px;font-weight:600;">${t("选区")}</div><div class="wc-line">${fmt(selCount)}</div>` : ""}
      <div class="modal-actions" style="margin-top:14px;"><button class="primary" data-close>${t("确定")}</button></div>
    </div></div>`;
    modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  }

  private updateColumnButton() {
    const btn = document.getElementById("btn-column");
    if (btn) btn.classList.toggle("active", isColumnMode());
  }

  private async toggleMode() {
    const doc = this.active;
    if (!doc) return;
    if (doc.mode === "text") {
      if (doc.isBinary) {
        this.alert(t("该文件为二进制文件，无法以文本显示。"));
        return;
      }
      if (doc.dirty) {
        const choice = await this.confirmDirty(doc);
        if (choice === "cancel") return;
        if (choice === "save") {
          const ok = await this.save(false);
          if (!ok) return;
        }
        doc.dirty = false;
        this.updateTabDot(doc);
      }
      doc.mode = "hex";
      if (doc.dirty && this.view) {
        doc.state = this.view.state;
      } else {
        doc.state = this.view?.state;
      }
      this.view?.setState(EditorState.create({ doc: "", extensions: this.extForDoc(doc) }));
      this.editorEl.classList.add("hidden");
      this.hexEl.classList.remove("hidden");
      if (!doc.path) {
        const text = doc.state ? doc.state.doc.toString() : "";
        doc.hexBytes = new TextEncoder().encode(text);
      }
      this.hex.open(doc);
      this.statusEls.lang.textContent = t("二进制");
    } else {
      if (doc.dirty) {
        const choice = await this.confirmDirty(doc);
        if (choice === "cancel") return;
        if (choice === "save") {
          const ok = await this.save(false);
          if (!ok) return;
        }
        doc.dirty = false;
        this.updateTabDot(doc);
      }
      doc.mode = "text";
      doc.hexBytes = this.hex.getBytes();
      doc.hexDirty = false;
      this.hexEl.classList.add("hidden");
      this.editorEl.classList.remove("hidden");
      const text = this.decodeUtf8(this.hex.getBytes());
      const state = EditorState.create({ doc: text, extensions: this.extForDoc(doc) });
      doc.state = state;
      if (!this.view) this.view = new EditorView({ parent: this.mainPanel });
      this.view.setState(state);
      this.view.focus();
      this.statusEls.lang.textContent = doc.path ? langForPath(doc.path).name : t("纯文本");
    }
    this.updateModeButton();
    this.renderTabs();
    this.updateStatus();
  }

  private decodeUtf8(bytes: Uint8Array): string {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return "";
    }
  }

  private updateModeButton() {
    const btn = document.getElementById("btn-mode");
    const doc = this.active;
    if (btn) {
      btn.textContent = doc && doc.mode === "hex" ? t("文本") : "0x16";
      btn.classList.toggle("active", !!doc && doc.mode === "hex");
    }
  }

  private toggleSidebar() {
    const sb = document.getElementById("sidebar")!;
    const collapsed = sb.classList.toggle("collapsed");
    if (collapsed) {
      sb.style.width = "18px";
      try { localStorage.setItem("uec.sidebar.collapsed", "1"); } catch { /* ignore */ }
    } else {
      const saved = parseInt(localStorage.getItem("uec.sidebar.w") || "", 10);
      sb.style.width = (saved > 40 ? saved : 220) + "px";
      try { localStorage.removeItem("uec.sidebar.collapsed"); } catch { /* ignore */ }
    }
    const btn = document.querySelector<HTMLElement>('[data-action="tree"]');
    btn?.classList.toggle("active", !collapsed);
    const toggle = document.getElementById("sb-toggle");
    if (toggle) toggle.textContent = collapsed ? "›" : "‹";
  }

  private restoreSidebarCollapsed() {
    const sb = document.getElementById("sidebar")!;
    if (localStorage.getItem("uec.sidebar.collapsed") !== "1") return;
    sb.classList.add("collapsed");
    sb.style.width = "18px";
    const toggle = document.getElementById("sb-toggle");
    if (toggle) toggle.textContent = "›";
  }

  private toggleTheme() {
    const root = document.documentElement;
    root.classList.toggle("dark");
    const btn = document.querySelector<HTMLElement>('[data-action="theme"]');
    btn?.classList.toggle("active", root.classList.contains("dark"));
    this.view?.requestMeasure();
  }

  // ---------------------------------------------------------------- save/open

  async save(saveAs: boolean): Promise<boolean> {
    const doc = this.active;
    if (!doc) return false;
    let path = doc.path;
    if (saveAs || !path) {
      if (inTauri()) {
        try {
          const picked = await dialogSave({
            title: "保存文件",
            defaultPath: path || doc.name,
          });
          if (!picked) return false;
          path = picked;
        } catch {
          /* 回退到浏览器下载 */
        }
      }
      if (!path) {
        this.downloadInBrowser(doc);
        return true;
      }
      doc.path = path;
      doc.name = path.split(/[\\/]/).pop() || path;
      if (doc.mode === "text" && !doc.isBinary) {
        const text = doc.state!.doc.toString();
        doc.state = EditorState.create({ doc: text, extensions: this.extForDoc(doc) });
        if (this.view) this.view.setState(doc.state);
      }
    }
    try {
      if (doc.mode === "hex") {
        await this.hex.save();
        doc.hexBytes = this.hex.getBytes();
        doc.dirty = false;
      } else {
        const text = doc.state!.doc.toString();
        await invoke("save_text_file", { path, text, encoding: doc.encoding, line_ending: doc.lineEnding, backup: true });
        doc.dirty = false;
        doc.size = new TextEncoder().encode(text).length;
      }
      if (doc.remote) {
        try {
          if (doc.remote.proto === "sftp") {
            await invoke("sftp_upload", { id: doc.remote.id, localPath: path, remotePath: doc.remote.path });
          } else {
            await invoke("ftp_upload", { id: doc.remote.id, localPath: path });
          }
        } catch (e) {
          this.alert(t("已保存本地，但写回远程失败：") + `\n${e}`);
        }
      }
      addRecent(path);
      if (doc.id) await invoke("clear_recovery", { key: doc.id }).catch(() => {});
    } catch (e) {
      this.alert(t("保存失败：") + `\n${e}`);
      return false;
    }
    this.updateTabDot(doc);
    this.renderTabs();
    this.updateStatus();
    return true;
  }

  private async openDialog() {
    if (inTauri()) {
      try {
        const picked = await dialogOpen({
          multiple: false,
          title: "打开文件",
        });
        if (picked) {
          await this.openFile(picked);
          return;
        }
      } catch {
        /* 原生对话框不可用，回退到浏览器文件选择 */
      }
    }
    this.pickFileInBrowser();
  }

  private pickFileInBrowser() {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      document.body.removeChild(input);
      const file = input.files?.[0];
      if (!file) return;
      const buf = new Uint8Array(await file.arrayBuffer());
      const encoding = detectBrowseEncoding(buf);
      let data = buf;
      if (encoding === "utf-8" && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        data = buf.subarray(3);
      }
      const text = decodeUint8(data, encoding);
      let lineEnding: LineEnding = "lf";
      const crlf = text.match(/\r\n/g)?.length ?? 0;
      const lf = text.match(/[^\r]\n/g)?.length ?? 0;
      const cr = text.match(/\r(?!\n)/g)?.length ?? 0;
      if (crlf >= lf && crlf >= cr) lineEnding = "crlf";
      else if (cr >= lf) lineEnding = "cr";
      const name = file.name;
      const doc: Document = {
        id: uid(), path: "", name, encoding,
        lineEnding, isBinary: false, mode: "text",
        dirty: false, size: file.size, truncated: false,
      };
      doc.state = EditorState.create({ doc: text, extensions: this.extForDoc(doc) });
      this.addDoc(doc);
    });
    document.body.appendChild(input);
    input.click();
  }

  private downloadInBrowser(doc: Document) {
    let text = "";
    if (doc.mode === "hex") {
      const bytes = this.hex.getBytes();
      if (bytes) text = new TextDecoder().decode(bytes);
    } else {
      text = doc.state?.doc.toString() ?? "";
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name || "untitled.txt";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    doc.dirty = false;
    this.updateTabDot(doc);
    this.renderTabs();
    this.updateStatus();
  }

  private async openFolderDialog() {
    if (!inTauri()) {
      this.alert(t("文件夹浏览需要桌面版（Tauri）环境，浏览器中请使用「打开文件」。"));
      return;
    }
    const picked = await dialogOpen({ directory: true, multiple: false, title: "打开文件夹" });
    if (!picked) return;
    const path = picked;
    this.searchDir = path;
    await this.tree.showRoot(path);
  }

  async closeTab(id: string) {
    const doc = this.docs.get(id);
    if (!doc) return;
    if (doc.dirty) {
      const choice = await this.confirmDirty(doc);
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await this.save(false);
        if (!ok) return;
      }
      doc.dirty = false;
    }
    this.docs.delete(id);
    this.tabOrder = this.tabOrder.filter((i) => i !== id);
    this.saveSessionNow();
    this.closeSplitIfNeeded(id);
    const remaining = [...this.docs.values()];
    if (this.activeId === id) {
      this.activeId = remaining.length ? remaining[remaining.length - 1].id : null;
      if (this.activeId) this.activate(this.activeId);
      else {
        this.closePreview();
        this.editorEl.classList.add("hidden");
        this.hexEl.classList.add("hidden");
        this.emptyStateEl.classList.remove("hidden");
        this.renderEmptyRecent();
        this.statusEls.path.textContent = "";
        this.statusEls.pos.textContent = "Ln 1, Col 1";
        this.statusEls.lang.textContent = "";
        this.statusEls.encoding.textContent = "";
        this.statusEls.size.textContent = "";
      }
    }
    this.renderTabs();
  }

  private onHexDirty() {
    const doc = this.active;
    if (!doc) return;
    doc.dirty = true;
    this.updateTabDot(doc);
  }

  // ---------------------------------------------------------------- keys

  private shortcutBinding(action: string): { key: string; shift: boolean } | null {
    const defs: Record<string, { key: string; shift?: boolean }> = {
      new: { key: "n" },
      open: { key: "o" },
      save: { key: "s" },
      saveAs: { key: "s", shift: true },
      find: { key: "f" },
      replace: { key: "f", shift: true },
      goto: { key: "g" },
      closeTab: { key: "w" },
      sidebar: { key: "b" },
      column: { key: "l" },
      palette: { key: "p", shift: true },
      split: { key: "\\" },
      cliphist: { key: "v", shift: true },
      mode: { key: "m" },
      print: { key: "p" },
    };
    try {
      const stored = JSON.parse(localStorage.getItem("uec.keys") || "{}");
      for (const a of Object.keys(defs)) {
        if (stored[a] && typeof stored[a].key === "string") {
          defs[a] = { ...defs[a], key: stored[a].key.toLowerCase(), shift: !!stored[a].shift };
        }
      }
    } catch {
      /* ignore */
    }
    const d = defs[action];
    return d ? { key: d.key, shift: !!d.shift } : null;
  }

  private bindGlobalKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (!mod) {
        if (e.key === "F3") {
          e.preventDefault();
          if (e.shiftKey) this.exec("findPrev");
          else this.exec("findNext");
        }
        return;
      }
      const actions = ["new", "open", "save", "saveAs", "find", "replace", "goto", "closeTab", "sidebar", "column", "palette", "split", "cliphist", "mode", "print"] as const;
      for (const a of actions) {
        const b = this.shortcutBinding(a);
        if (b && b.key === k && b.shift === e.shiftKey) {
          e.preventDefault();
          this.runAction(a);
          return;
        }
      }
    });
    document.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest?.(".dropdown-menu")) return;
      this.closeMenus();
    });
  }
}