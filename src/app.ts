import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
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
import { defaultHighlightStyle, bracketMatching, syntaxHighlighting, indentOnInput, foldGutter, foldKeymap, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, findNext, findPrevious, selectMatches, RegExpCursor } from "@codemirror/search";
import type { Document, FileEntry } from "./types";
import { langForPath } from "./langs";
import { rectangleSelection, setColumnMode, isColumnMode, rectKeyboard } from "./rect";
import { HexEditor, formatSize } from "./hex";
import { FindBar, searchHighlight } from "./find";
import { FileTree } from "./filetree";
import { bookmarks, toggleBookmark, nextBookmark, prevBookmark, clearAllBookmarks, getBookmarkLines } from "./bookmarks";
import { editPositionListener, jumpBack, jumpForward } from "./jumplist";
import { sortSelection, titleCaseSelection, joinLines, upperCaseCmd, lowerCaseCmd, toggleCaseCmd, insertNumberSequence, convertLineEndings, lineEndingLabel, rewrapLines, type LineEnding } from "./editops";
import { getRecent, addRecent, clearRecent } from "./recent";
import { FileSearch } from "./filesearch";
import { CommandPalette, type CommandEntry } from "./palette";
import { QuickOpen, type QuickOpenFile } from "./quickopen";
import { RemoteTerm, type TermParams } from "./term";
import { macroExtension, toggleRecordMacro, clearMacro, runMacro, macroManagerDialog, isRecording } from "./macro";
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
import { RemoteBrowser , newTransferId } from "./remote";
import { Outline } from "./outline";
import { TileCell, TerminalTileCell } from "./tile";
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

// 真实 Tauri 环境判定：__TAURI_INTERNALS__ 完整（含 metadata）才算。
// e2e 测试的 mock 只提供 invoke，缺少 metadata，用于区分并跳过真实插件调用（如自动检查更新）。
const isRealTauri = (): boolean => {
  try {
    const t = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__;
    return !!t?.metadata;
  } catch {
    return false;
  }
};

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

// 深色主题专用语法高亮配色（VS Code Dark+ 风格），解决 defaultHighlightStyle 浅色配色在深色背景几乎不可见的问题
const DARK_HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.moduleKeyword], color: "#569cd6" },
  { tag: [tags.string, tags.special(tags.string), tags.docString], color: "#ce9178" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#b5cea8" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: "#dcdcaa" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#4ec9b0" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName, tags.definition(tags.variableName)], color: "#9cdcfe" },
  { tag: [tags.tagName], color: "#569cd6" },
  { tag: [tags.attributeValue], color: "#ce9178" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "#d4d4d4" },
  { tag: [tags.meta, tags.processingInstruction], color: "#d4d4d4" },
  { tag: [tags.regexp], color: "#d16969" },
  { tag: [tags.labelName], color: "#dcdcaa" },
  { tag: [tags.invalid], color: "#f44747" },
  // Markdown 专属配色
  { tag: [tags.heading], color: "#4ec9b0", fontWeight: "bold" },
  { tag: [tags.strong], color: "#569cd6", fontWeight: "bold" },
  { tag: [tags.emphasis], color: "#dcdcaa", fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "#6cb6ff", textDecoration: "underline" },
  { tag: [tags.quote], color: "#6a9955", fontStyle: "italic" },
  { tag: [tags.monospace], color: "#ce9178" },
  { tag: [tags.list], color: "#d4d4d4" },
]);

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

// 预设主题：id → { 显示名, 深浅配对（toggleTheme 切换目标） }
const THEMES: Record<string, { name: string; pair: string }> = {
  "default-dark": { name: "默认深色", pair: "default-light" },
  "default-light": { name: "默认浅色", pair: "default-dark" },
  "ultraedit": { name: "经典蓝", pair: "default-light" },
  "solarized-dark": { name: "Solarized 深色", pair: "solarized-light" },
  "solarized-light": { name: "Solarized 浅色", pair: "solarized-dark" },
  "monokai": { name: "Monokai", pair: "default-light" },
  "high-contrast": { name: "高对比度", pair: "default-light" },
  "github-light": { name: "GitHub 浅色", pair: "default-dark" },
};

const DARK_THEMES = new Set(["default-dark", "ultraedit", "solarized-dark", "monokai", "high-contrast"]);

function isDarkTheme(id: string): boolean {
  return DARK_THEMES.has(id);
}

// 按当前主题深浅选择语法高亮配色：深色用 DARK_HIGHLIGHT，浅色用 CodeMirror 默认
function highlightForTheme(): import("@codemirror/state").Extension {
  const cur = localStorage.getItem("uec.theme") || "default-dark";
  return syntaxHighlighting(isDarkTheme(cur) ? DARK_HIGHLIGHT : defaultHighlightStyle);
}

type MenuEntry = [string, () => void, string?] | [string, () => void, string, boolean | (() => boolean)];

export class App {
  private view: EditorView | null = null;
  private docs = new Map<string, Document>();
  private tabOrder: string[] = [];
  private activeId: string | null = null;
  private terms = new Map<string, RemoteTerm>();
  private dirtyTimers = new Map<string, number>();
  private termSite = new Map<string, string>(); // 终端标签 → 远程服务器会话 siteId
  private termOrder: string[] = [];
  private activeTermId: string | null = null;
  private termArea: HTMLElement;
  private editorEl: HTMLElement;
  private mainPanel: HTMLElement;
  private mdToolbarEl: HTMLElement;
  private splitPanel: HTMLElement;
  private previewPanel!: HTMLElement;
  private preview: MarkdownPreview | null = null;
  private previewOn = false;
  private prefWrap = false;
  private prefWs = false;
  private prefPreview = false;
  private previewTimer: any = null;
  private splitView: EditorView | null = null;
  private syntaxCompartment = new Compartment();
  private splitDocId: string | null = null;
  // 分屏双向同步防循环标志（左侧↔右侧）
  private splitSyncing = false;
  // 多标签平铺（SecureCRT Tile 风格）
  private tileMode: "v" | "h" | null = null;
  private tileCells = new Map<string, TileCell>();
  private termTileCells = new Map<string, TerminalTileCell>();
  private tileArea: HTMLElement;
  private hexEl: HTMLElement;
  private tabbarEl: HTMLElement;
  private emptyStateEl: HTMLElement;
  private statusEls: Record<string, HTMLElement>;
  private hex: HexEditor;
  private find: FindBar;
  private tree: FileTree;
  private remote: RemoteBrowser;
  private showHidden = (() => {
    try {
      return localStorage.getItem("0xedit.showHidden") === "1";
    } catch {
      return false;
    }
  })();
  private hexRoot: HTMLElement;
  private searchDir = "";
  private fileSearch: FileSearch;
  private palette: CommandPalette;
  private quickOpen: QuickOpen;
  private outline: Outline;
  private searchItems: Array<{ path: string; line: number; content: string }> = [];
  private autosave = false;
  private autosaveTimer: number | null = null;

  constructor() {
    this.editorEl = document.getElementById("editor-container")!;
    this.mainPanel = document.getElementById("main-panel")!;
    this.mdToolbarEl = document.getElementById("md-toolbar")!;
    this.splitPanel = document.getElementById("split-panel")!;
    this.previewPanel = document.getElementById("preview-panel")!;
    this.hexEl = document.getElementById("hex-container")!;
    this.termArea = document.getElementById("term-area")!;
    this.tileArea = document.getElementById("tile-area")!;
    this.tabbarEl = document.getElementById("tabbar")!;
    const moreBtn = document.getElementById("tab-more");
    if (moreBtn) moreBtn.addEventListener("click", () => this.openTabMoreMenu());
    this.tabbarEl.addEventListener("wheel", (e) => {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      if (dy > dx && this.tabbarEl.scrollWidth > this.tabbarEl.clientWidth) {
        this.tabbarEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
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
    // 状态栏编码可点击：参考 UltraEdit 状态栏编码下拉，按选择字符集重新解码查看
    this.statusEls.encoding.classList.add("clickable");
    this.statusEls.encoding.addEventListener("click", () => this.reopenAsDialog());
    this.fileSearch = new FileSearch(
      (p, l) => this.openFileAtLine(p, l),
      (items) => {
        this.searchItems = items.map((i) => ({ path: i.path, line: i.line, content: i.content }));
        this.renderSearchPanel();
      },
    );
    this.palette = new CommandPalette();
    this.quickOpen = new QuickOpen();
    this.outline = new Outline(document.getElementById("outline-panel")!, (line) => this.gotoLineInActive(line));
    this.outline.bind();
    this.remote = new RemoteBrowser(
      document.getElementById("remote-panel")!,
      (tmp, proto, id, remotePath) => this.openRemoteDoc(tmp, proto, id, remotePath),
      () => this.active?.path ?? "",
      (tmp, kind, entry, archiveName, proto, id, remotePath) =>
        this.openArchiveDoc(tmp, kind, entry, archiveName, proto, id, remotePath),
      this.showHidden,
      (params, initialDir, siteId) => this.openTerminal(params, initialDir, siteId),
      (siteId) => this.closeTermsBySite(siteId),
    );
    this.bindSidebarTabs();
    this.bindHiddenToggle();
    this.bindRefreshButtons();
    this.bindSidebarResize();
    this.restoreSidebarCollapsed();
    this.find = new FindBar(document.getElementById("searchbar")!, () => this.curView);
    this.tree = new FileTree(document.getElementById("filetree")!, (p) => this.openFile(p), (p, kind, entry, name) =>
      this.openArchiveDoc(p, kind, entry, name), this.showHidden);
    this.hexRoot = this.hexEl;
    // 窗口重新获得焦点时刷新本地目录树（覆盖 Finder/终端等外部改动后切回的场景）
    // 仅 Tauri 环境可用；纯浏览器或 e2e mock（__TAURI_INTERNALS__ 不完整）时安全跳过
    try {
      getCurrentWindow().onFocusChanged(({ payload }) => {
        if (payload) this.tree?.refresh();
      });
    } catch {
      /* 非 Tauri 环境 */
    }
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
    // 全局右键：阻止 macOS WKWebView 系统原生菜单；编辑区弹自定义菜单
    window.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        const t = e.target as HTMLElement | null;
        if (t?.closest?.(".cm-editor")) this.showEditorCtxMenu(e);
      },
      true
    );
    this.bindCloseHook();
    this.newDoc();
    this.loadHome();
    this.checkRecovery();
    void this.restoreSession();
    // 启动后延迟静默检查更新：仅真实 Tauri 环境（e2e mock 无 metadata，跳过，避免弹窗干扰测试）
    if (isRealTauri()) {
      window.setTimeout(() => {
        void this.checkForUpdate(true);
      }, 5000);
    }
  }

  private bindCloseHook() {
    this.saveSessionSoon();
    // 仅 Tauri 环境可用；纯浏览器（dev/e2e）下 getCurrentWindow 不存在，跳过
    if (!inTauri()) return;
    try {
      let allowClose = false;
      getCurrentWindow().onCloseRequested(async (event) => {
        // 二次关闭（保存完成后的 close() 重入）直接放行默认关闭，避免死循环
        if (allowClose) return;
        try {
          this.saveSessionNow();
        } catch {
          /* ignore */
        }
        const dirty = [...this.docs.values()].filter((d) => d.dirty);
        if (!dirty.length) return;
        event.preventDefault();
        // 逐个提示（UltraEdit 行为）：每个未保存文件独立选择 保存/不保存/取消
        for (const d of dirty) {
          const choice = await this.confirmDirty(d);
          if (choice === "cancel") return;
          if (choice === "save") {
            const ok = await this.saveDocWithDialog(d);
            if (!ok) return; // 另存为被取消 → 中止关闭
          }
        }
        allowClose = true;
        try {
          // 再次请求关闭：回调重入后 allowClose 放行，走原生默认关闭
          await getCurrentWindow().close();
        } catch {
          try {
            getCurrentWindow().destroy();
          } catch {
            window.close();
          }
        }
      });
    } catch {
      /* not in tauri */
    }
  }

  private saveSessionNow() {
    try {
      const paths: string[] = [];
      const pos: Record<string, { line: number; ch: number }> = {};
      for (const d of this.docs.values()) {
        if (!d.path || d.isBinary || d.remote) continue;
        paths.push(d.path);
        if (d.state) {
          try {
            const head = d.state.selection.main.head;
            const ln = d.state.doc.lineAt(Math.min(head, d.state.doc.length));
            pos[d.path] = { line: ln.number, ch: head - ln.from };
          } catch {
            /* ignore */
          }
        }
      }
      localStorage.setItem("uec.session.paths", JSON.stringify(paths));
      localStorage.setItem("uec.session.pos", JSON.stringify(pos));
      const activeDoc = this.active;
      localStorage.setItem(
        "uec.session.active",
        activeDoc && activeDoc.path && !activeDoc.isBinary && !activeDoc.remote ? activeDoc.path : "",
      );
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
      let savedPos: Record<string, { line: number; ch: number }> = {};
      try {
        savedPos = JSON.parse(localStorage.getItem("uec.session.pos") || "{}");
      } catch {
        /* ignore */
      }
      const activePath = localStorage.getItem("uec.session.active") || "";
      // 恢复全部本地文本标签（不截断），每个恢复光标位置
      for (const p of paths) {
        await this.openFile(p).catch(() => {});
        const s = savedPos[p];
        const v = this.curView;
        const doc = this.active;
        if (s && v && doc && doc.path === p && doc.mode === "text" && !doc.isBinary) {
          try {
            const ln = v.state.doc.line(Math.max(1, Math.min(s.line, v.state.doc.lines)));
            const ch = Math.min(s.ch, ln.length);
            v.dispatch({
              selection: { anchor: ln.from + ch },
              effects: [EditorView.scrollIntoView(ln.from + ch, { y: "center" })],
            });
          } catch {
            /* ignore */
          }
        }
      }
      // 恢复上次激活的标签（openFile 对已打开文件会切到对应 tab）
      if (activePath && paths.includes(activePath) && this.active?.path !== activePath) {
        await this.openFile(activePath).catch(() => {});
      }
      if (this.prefPreview) {
        const d = this.active;
        if (d && d.mode !== "hex" && isMarkdownDoc(this.docLangPath(d), d.name)) this.openPreview();
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
      if (saved > 0) sb.style.width = Math.min(saved, window.innerWidth * 0.5) + "px";
    } catch {
      /* ignore */
    }
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // 拖动期间禁用 width 过渡，避免 0.12s 动画拖慢拖动跟手度
      sb.classList.add("resizing");
      const startX = e.clientX;
      const startW = sb.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        // 上限：窗口宽度的 50%（Finder 侧栏式），下限 140px
        const w = Math.max(140, Math.min(window.innerWidth * 0.5, startW + (ev.clientX - startX)));
        sb.style.width = w + "px";
      };
      const up = () => {
        sb.classList.remove("resizing");
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
    document.getElementById("tabbar")?.classList.remove("wrap");
    header.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>(".sb-tab");
      if (!tab) return;
      const name = tab.dataset.sb;
      header.querySelectorAll(".sb-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("local-wrap")!.classList.toggle("hidden", name !== "local");
      document.getElementById("outline-panel")!.classList.toggle("hidden", name !== "outline");
      document.getElementById("bookmarks-panel")!.classList.toggle("hidden", name !== "bookmarks");
      document.getElementById("search-panel")!.classList.toggle("hidden", name !== "search");
      document.getElementById("remote-panel")!.classList.toggle("hidden", name !== "remote");
      if (name === "outline") this.refreshOutline();
      if (name === "bookmarks") this.renderBookmarksPanel();
    });
  }

  // 显示隐藏文件总开关（本地 + 远程，状态持久化）
  // 按钮位于路径栏内、由 FileTree/RemoteBrowser 动态渲染，故用事件委托
  private bindHiddenToggle() {
    const sync = () => {
      for (const b of Array.from(document.querySelectorAll<HTMLElement>("#sb-hidden-local, #sb-hidden-remote"))) {
        b.classList.toggle("on", this.showHidden);
        b.title = t(this.showHidden ? "隐藏隐藏文件" : "显示隐藏文件");
      }
    };
    sync();
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("#sb-hidden-local, #sb-hidden-remote");
      if (!btn) return;
      e.preventDefault();
      this.showHidden = !this.showHidden;
      try {
        localStorage.setItem("0xedit.showHidden", this.showHidden ? "1" : "0");
      } catch {
        /* ignore */
      }
      sync();
      this.tree.setShowHidden(this.showHidden);
      this.remote.setShowHidden(this.showHidden);
    });
  }

  // 刷新入口：本地/远程树路径栏右侧（与隐藏文件眼睛并列，事件委托）
  private bindRefreshButtons() {
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("#sb-refresh-local, #sb-refresh-remote");
      if (!btn) return;
      e.preventDefault();
      if (btn.id === "sb-refresh-local") void this.tree.refresh();
      else void this.remote.refresh();
    });
  }

  private gotoLineInActive(line: number) {
    const v = this.curView;
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
    const v = this.curView;
    if (!doc || !v || doc.mode === "hex" || !doc.path) {
      this.outline.clear();
      return;
    }
    this.outline.render(doc.path, v.state.doc.toString());
  }

  // 书签面板：列出所有打开文件的全部书签，点击跳转
  private renderBookmarksPanel() {
    const el = document.getElementById("bookmarks-panel");
    if (!el) return;
    const rows: string[] = [];
    for (const d of this.docs.values()) {
      if (!d.path || d.isBinary || d.mode === "hex" || !d.state) continue;
      const lines = getBookmarkLines(d.state);
      for (const ln of lines) {
        let text = "";
        try {
          text = d.state.doc.line(ln).text.trim();
        } catch {
          /* line may be gone */
        }
        rows.push(`<div class="bm-item" data-path="${escapeHtmlFor(d.path)}" data-line="${ln}">
          <span class="bm-path">${escapeHtmlFor(d.name)}</span>
          <span class="bm-line">${ln}</span>
          <span class="bm-text">${escapeHtmlFor(text.slice(0, 80) || "∅")}</span>
        </div>`);
      }
    }
    el.innerHTML = rows.length
      ? rows.join("")
      : `<div class="outline-empty">${t("暂无书签（点击行号旁的书签栏，或按 ⌘F2 添加）")}</div>`;
    el.querySelectorAll<HTMLElement>(".bm-item").forEach((it) => {
      it.addEventListener("click", () => {
        const p = it.dataset.path!;
        const line = parseInt(it.dataset.line!, 10);
        const doc = [...this.docs.values()].find((d) => d.path === p && !d.isBinary);
        if (!doc) return;
        if (this.activeId !== doc.id) this.activate(doc.id);
        window.setTimeout(() => this.gotoLineInActive(line), 30);
      });
    });
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
    let n = 1;
    const re = /^(?:无标题|Untitled|無題)\s*(\d+)$/;
    for (const d of this.docs.values()) {
      const m = d.name.match(re);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    }
    const doc: Document = {
      id: uid(),
      path: "",
      name: `${t("无标题")} ${n}`,
      encoding: "utf-8",
      lineEnding: "lf",
      isBinary: false,
      mode: "text",
      dirty: false,
      savedContent: "",
      size: 0,
      truncated: false,
    };
    this.addDoc(doc);
  }

  private addDoc(doc: Document) {
    this.docs.set(doc.id, doc);
    this.tabOrder.push(doc.id);
    this.renderTabs();
    if (this.tileMode && doc.mode === "text" && this.tileCells.size < 12) {
      const cell = new TileCell(
        doc,
        (id) => this.activateTileCell(id),
        (id) => void this.closeTab(id),
        (x, y, d) => this.showTabMenu(x, y, d as Document),
      );
      this.tileCells.set(doc.id, cell);
      this.tileArea.appendChild(cell.el);
      this.layoutTiles(this.tileCells.size);
      const total = [...this.docs.values()].filter((d) => d.mode === "text").length;
      this.updateTileMore(total, this.tileCells.size);
      this.activateTileCell(doc.id);
      this.saveSessionNow();
      return;
    }
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
      doc.savedContent = res.text;
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

  // 归档内文档的 path 是归档文件本身，语言识别与显示需用条目名（entry）
  private docLangPath(doc: Document): string | undefined {
    if (doc.archive) return doc.archive.entry;
    if (doc.remote) return doc.remote.path;
    return doc.path;
  }

  private extForDoc(doc: Document): import("@codemirror/state").Extension[] {
    const langPath = this.docLangPath(doc);
    const lang = langPath ? langForPath(langPath) : { ext: [], name: t("纯文本") };
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
      autocompletion({ override: [snippetCompletionSource, kwSourceFor(this.docLangPath(doc) || "")] }),
      EditorView.domEventHandlers({
        paste: (e) => this.mdPasteImage(e),
        drop: (e) => this.mdDropImage(e),
      }),
      this.syntaxCompartment.of(highlightForTheme()),
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
      langCompartment.of(isMarkdownDoc(this.docLangPath(doc), doc.name) ? markdown({ base: markdownLanguage }) : lang.ext),
      themeBase(),
      rectangleSelection,
      rectKeyboard,
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
      keymap.of(isMarkdownDoc(this.docLangPath(doc), doc.name) ? [
        { key: "Mod-b", run: () => { this.mdFormat("bold"); return true; } },
        { key: "Mod-i", run: () => { this.mdFormat("italic"); return true; } },
        { key: "Mod-Shift-x", run: () => { this.mdFormat("strike"); return true; } },
        { key: "Mod-Shift-c", run: () => { this.mdFormat("code"); return true; } },
        { key: "Mod-Shift-a", run: () => { this.mdFormat("codeblock"); return true; } },
        { key: "Mod-k", run: () => { this.mdFormat("link"); return true; } },
      ] : []),
    ];
    if (lang.ext) base.push(lang.ext);
    return base;
  }

  private markSaved(doc: Document) {
    doc.dirty = false;
    if (doc.state) doc.savedContent = doc.state.doc.toString();
    this.updateTabDot(doc);
  }

  private scheduleDirtyCheck(doc: Document) {
    if (doc.savedContent === undefined) return;
    const prev = this.dirtyTimers.get(doc.id);
    if (prev) clearTimeout(prev);
    const timer = window.setTimeout(() => {
      this.dirtyTimers.delete(doc.id);
      if (!doc.dirty || !doc.state) return;
      const sc = doc.savedContent;
      if (sc === undefined) return;
      const cur = doc.state.doc.toString();
      if (cur.length === sc.length && cur === sc) {
        doc.dirty = false;
        this.updateTabDot(doc);
      }
    }, 400);
    this.dirtyTimers.set(doc.id, timer);
  }

  private onEditorUpdate(u: import("@codemirror/view").ViewUpdate) {
    const doc = this.active;
    if (!doc) return;
    doc.state = u.state;
    // 左侧编辑 → 实时同步到分屏右侧（防循环由 splitSyncing 保证）
    if (this.splitView && this.splitDocId === doc.id && u.docChanged && !this.splitSyncing) {
      this.splitSyncing = true;
      try {
        this.splitView.dispatch({
          changes: { from: 0, to: this.splitView.state.doc.length, insert: u.state.doc.toString() },
        });
      } finally {
        this.splitSyncing = false;
      }
    }
    if (u.docChanged) {
      doc.dirty = true;
      this.updateTabDot(doc);
      this.scheduleDirtyCheck(doc);
    }
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.updateStatus();
    }
    if (this.tileMode) {
      const cell = this.tileCells.get(doc.id);
      if (cell && u.docChanged) cell.scheduleRefresh();
      if (cell && u.selectionSet && cell.previewVisible) {
        cell.refreshPreview();
      }
      return;
    }
    if (u.docChanged && !document.getElementById("outline-panel")!.classList.contains("hidden")) {
      this.refreshOutline();
    }
    if (u.docChanged && this.previewOn) this.schedulePreview();
    // 光标位置驱动预览：仅滚动不触发时（如键盘/点击把光标移到顶部）也跟随
    if (u.selectionSet && this.previewOn && this.preview) {
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(head).number;
      this.preview.syncCursor(line, u.state.doc.lines);
    }
  }

  private activate(id: string) {
    const prev = this.active;
    this.activeTermId = null;
    this.termArea.classList.add("hidden");
    if (this.tileMode) {
      const doc = this.docs.get(id);
      if (!doc) return;
      if (doc.mode === "hex") {
        // hex 不参与平铺：先合并回单格再走常规激活
        this.mergeTags();
      } else {
        this.activateTileCell(id);
        return;
      }
    }
    if (prev && prev.id !== id && this.view) {
      prev.scrollTop = this.view.scrollDOM.scrollTop;
    }
    this.activeId = id;
    const doc = this.docs.get(id)!;
    if (doc.mode === "hex") {
      if (this.previewOn) this.closePreview(true);
      // 十六进制不支持分屏：切换时关闭
      if (this.splitView) this.destroySplit();
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
      const langPath = this.docLangPath(doc);
      this.statusEls.lang.textContent = langPath ? langForPath(langPath).name : t("纯文本");
      // 分屏跟随当前文档：切换文本标签时右侧重新渲染（hex 已在上方关闭分屏）
      if (this.splitView && this.splitDocId !== doc.id) this.openInSplit(doc.id);
    }
    this.renderTabs();
    // 切回 Markdown 且用户此前开启过预览 → 自动恢复双栏（分屏打开时不抢，避免三栏）
    if (
      !this.splitView &&
      doc.mode !== "hex" && this.prefPreview && !this.previewOn && isMarkdownDoc(this.docLangPath(doc), doc.name)
    ) {
      this.openPreview();
    }
    this.updateStatus();
    this.updateModeButton();
    this.updateColumnButton();
    if (this.previewOn) this.refreshPreview();
  }

  private updateStatus() {
    const doc = this.active;
    if (!doc) return;
    this.syncPreviewBtn();
    this.syncMdToolbar();
    this.statusEls.path.textContent = doc.path || t(doc.name);
    this.statusEls.encoding.textContent = `${doc.encoding} · ${lineEndingLabel(doc.lineEnding)}`;
    const langPath = this.docLangPath(doc);
    this.statusEls.lang.textContent = langPath ? langForPath(langPath).name : t("纯文本");
    if (doc.mode === "hex") {
      this.statusEls.size.textContent = formatSize(doc.hexBytes?.length ?? doc.size);
    } else {
      const len = doc.state?.doc.length ?? 0;
      this.statusEls.size.textContent = `${len} ${t("字符")}`;
      const v = this.curView;
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
    if (tab) {
      const dot = tab.querySelector<HTMLElement>(".tab-dot");
      if (dot) dot.style.opacity = doc.dirty ? "1" : "0";
    }
    const cell = this.tileCells.get(doc.id);
    cell?.setDirty(!!doc.dirty);
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
    for (const id of this.termOrder) {
      const term = this.terms.get(id);
      if (!term) continue;
      const tab = document.createElement("div");
      tab.className = "tab term-tab";
      if (id === this.activeTermId) tab.classList.add("active");
      tab.dataset.tab = id;
      tab.dataset.kind = "term";
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = term.title || `${t("终端")} @ ${term.host}`;
      name.title = term.remoteTitle || term.title || name.textContent;
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "✕";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTerm(id);
      });
      tab.append(name, close);
      tab.addEventListener("click", () => this.activateTerm(id));
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showTermMenu(e.clientX, e.clientY, id);
      });
      this.tabbarEl.appendChild(tab);
    }
    // 平铺模式下格子标题与终端 tab 名保持一致（含"重命名会话"）
    this.termTileCells.forEach((cell, tid) => {
      const tm = this.terms.get(tid);
      if (tm) cell.setTitle(tm.title);
    });
    const active = this.tabbarEl.querySelector<HTMLElement>(".tab.active");
    if (active) {
      const bar = this.tabbarEl;
      const l = active.offsetLeft;
      const r = l + active.offsetWidth;
      if (l < bar.scrollLeft) bar.scrollLeft = l;
      else if (r > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = r - bar.clientWidth;
    }
    this.refreshTabMore();
  }

  private refreshTabMore() {
    const btn = document.getElementById("tab-more");
    if (!btn) return;
    const over = this.tabbarEl.scrollWidth > this.tabbarEl.clientWidth + 2;
    btn.classList.toggle("hidden", !over);
  }

  private openTabMoreMenu() {
    const items: MenuEntry[] = [];
    for (const id of this.tabOrder) {
      const d = this.docs.get(id);
      if (!d) continue;
      items.push([d.name + (d.dirty ? " •" : ""), () => this.activate(id), "", () => d.id === this.activeId]);
    }
    if (items.length > 0 && this.termOrder.length > 0) items.push(["---", () => {}]);
    for (const id of this.termOrder) {
      const tm = this.terms.get(id);
      if (!tm) continue;
      const title = tm.title || `${t("终端")} @ ${tm.host}`;
      items.push([title, () => this.activateTerm(id), "", () => id === this.activeTermId]);
    }
    const btn = document.getElementById("tab-more");
    if (btn) this.showMenuAt(btn, items);
  }

  private showEditorCtxMenu(e: MouseEvent) {
    const doc = this.active;
    const v = this.curView;
    if (!doc || !v || doc.mode === "hex") return;
    const sel = v.state.selection.main;
    const hasSel = !sel.empty;
    const items: MenuEntry[] = [
      ["撤销", () => this.exec("undo"), "⌘Z"],
      ["重做", () => this.exec("redo"), "⇧⌘Z"],
      ["---", () => {}],
      ["剪切", () => this.exec("cut"), "⌘X"],
      ["复制", () => this.exec("copy"), "⌘C"],
      ["粘贴", () => this.exec("paste"), "⌘V"],
      ["全选", () => this.exec("selectAll"), "⌘A"],
      ["---", () => {}],
      ["查找…", () => this.find.open(), "⌘F"],
      ["替换…", () => this.find.open({ replace: true }), "⇧⌘F"],
      ["---", () => {}],
      ["自动换行", () => this.toggleWrap(), "", () => this.prefWrap],
      ["显示空白字符", () => this.toggleWhitespace(), "", () => this.prefWs],
      ["---", () => {}],
      ["复制路径", () => {
        void navigator.clipboard.writeText(doc.path || doc.name);
      }],
    ];
    void hasSel;
    this.showMenu(e.clientX, e.clientY, items);
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

  private showTermMenu(x: number, y: number, id: string) {
    const term = this.terms.get(id);
    if (!term) return;
    const title = term.title || `${t("终端")} @ ${term.host}`;
    const items: Array<[string, () => void]> = [
      ["重命名会话…", () => void this.renameTerm(id)],
      ["关闭", () => this.closeTerm(id)],
      ["关闭其他终端", () => {
        for (const x of [...this.termOrder]) if (x !== id) this.closeTerm(x);
      }],
      ["关闭所有终端", () => {
        for (const x of [...this.termOrder]) this.closeTerm(x);
      }],
      ["复制会话信息", () => {
        void navigator.clipboard.writeText(title);
      }],
    ];
    this.showMenu(x, y, items);
  }

  private async renameTerm(id: string) {
    const term = this.terms.get(id);
    if (!term) return;
    const cur = term.title || `${t("终端")} @ ${term.host}`;
    const name = await this.promptText(t("重命名会话"), t("会话名称"), cur);
    if (!name || name.trim() === "") return;
    term.title = name.trim();
    this.renderTabs();
  }

  private promptText(title: string, label: string, value = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:320px;">
        <div class="modal-title">${escapeHtmlFor(title)}</div>
        <div class="modal-body">
          <label class="acct-f">${escapeHtmlFor(label)}<input id="pt-input" class="fs-input" value="${escapeHtmlFor(value)}" autofocus/></label>
        </div>
        <div class="modal-actions">
          <button class="search-btn" id="pt-ok">确定</button>
          <button class="search-btn" id="pt-cancel">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector<HTMLInputElement>("#pt-input")!;
      const done = (v: string | null) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#pt-ok")!.addEventListener("click", () => done(input.value.trim() || null));
      mask.querySelector("#pt-cancel")!.addEventListener("click", () => done(null));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) done(null);
      });
      input.focus();
      input.select();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(input.value.trim() || null);
        if (e.key === "Escape") done(null);
      });
    });
  }

  // ---------------------------------------------------------------- menu

  private menuData: Record<string, () => MenuEntry[]> = {
    "文件": () => [
      ["新建", () => this.newDoc(), "⌘N"],
      ["打开文件…", () => this.openDialog(), "⌘O"],
      ["快速打开文件…", () => void this.openQuickOpen(), "⌘P"],
      ["打开文件夹…", () => this.openFolderDialog(), ""],
      ["---", () => {}, ""],
      ["保存", () => this.save(false), "⌘S"],
      ["另存为…", () => this.save(true), "⇧⌘S"],
      ["导出为 HTML（可打印/存 PDF）", () => this.exportHtml(), ""],
      ["导出 Markdown（HTML/PDF）", () => this.exportMarkdown(), ""],
      ["导出为 Word（.doc）", () => this.exportWord(), ""],
      ["打印…", () => this.printActive(), ""],
      ["重新打开为…", () => this.reopenAsDialog(), ""],
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
      ["列编辑模式", () => this.toggleColumn(), "⌘L", () => isColumnMode()],
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
      ["录制/停止宏", () => this.execCmd(toggleRecordMacro), "", () => { const v = this.curView; return !!v && isRecording(v.state); }],
      ["播放宏", () => this.execCmd(runMacro), ""],
      ["清除宏", () => this.execCmd(clearMacro), ""],
      ["宏管理…", () => {
        const v = this.curView;
        if (v) macroManagerDialog(v, (m) => { this.statusEls.pos.textContent = m; });
      }, ""],
      ["代码片段…", () => snippetManagerDialog(), ""],
      ["剪贴板历史…", () => this.openClipHist(), "⇧⌘V"],
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
      ["切换侧边栏", () => this.toggleSidebar(), "⌘B", () => !document.getElementById("sidebar")!.classList.contains("collapsed")],
      ["切换主题", () => this.toggleTheme(), ""],
      ["切换文本/十六进制", () => this.toggleMode(), "⌘M", () => this.active?.mode === "hex"],
      ["标签列表…", () => this.showTabList(), ""],
      ["拆分/合并窗口", () => this.toggleSplit(), "⌘\\", () => !!this.splitView],
      [this.previewOn ? t("关闭预览") : t("Markdown 预览"), () => this.togglePreview(), "⇧⌘E", () => this.previewOn],
      ["自动换行", () => this.toggleWrap(), "", () => this.prefWrap],
      ["显示空白字符", () => this.toggleWhitespace(), "", () => this.prefWs],
      ["自动保存", () => this.toggleAutosave(), "", () => this.autosave],
      ["设置…", () => this.settingsDialog(), ""],
          ["清空最近文件", () => { clearRecent(); this.alert(t("已清空最近文件列表。")); }, ""],
    ],
    "窗口": () => [
      ["平铺标签（上下）", () => this.tileTags("v"), "", () => this.tileMode === "v"],
      ["平铺标签（左右）", () => this.tileTags("h"), "", () => this.tileMode === "h"],
      ["合并标签", () => this.mergeTags(), "", () => !!this.tileMode],
      ["---", () => {}, ""],
      ["拆分/合并窗口", () => this.toggleSplit(), "⌘\\", () => !!this.splitView],
    ],
    "帮助": () => [
      ["检查更新…", () => this.checkForUpdate(), ""],
      ["关于", () => void this.showAbout(), ""],
    ],
    "语言": () => [
      ["简体中文", () => setLang("zh-CN"), "", () => getLang() === "zh-CN"],
      ["English", () => setLang("en-US"), "", () => getLang() === "en-US"],
      ["日本語", () => setLang("ja-JP"), "", () => getLang() === "ja-JP"],
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
    set("search-bookmark", "text", t("全部加书签"));
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
    const tabs: Record<string, string> = {
      local: "本地",
      outline: "大纲",
      bookmarks: "书签",
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
        // Chrome 风格 toggle：已打开则关闭，未打开则打开
        if (item.classList.contains("open")) this.closeMenus();
        else this.showMenuAt(item, this.menuData[label]());
      });
      // 菜单已打开时，鼠标滑到其他顶级项直接切换（Chrome/桌面应用交互）
      item.addEventListener("mouseenter", () => {
        if (document.querySelector(".dropdown-menu")) this.showMenuAt(item, this.menuData[label]());
      });
      bar.appendChild(item);
    }
  }

  private showMenuAt(anchor: HTMLElement, items: MenuEntry[]) {
    this.closeMenus();
    const rect = anchor.getBoundingClientRect();
    this.showMenu(rect.left, rect.bottom, items);
    // showMenu 内部会 closeMenus 一次，open 标记须在菜单渲染后设置
    anchor.classList.add("open");
  }

  private showMenu(x: number, y: number, items: MenuEntry[]) {
    this.closeMenus();
    const menu = document.createElement("div");
    menu.className = "dropdown-menu";
    for (const [label, fn, hint, checked] of items) {
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
      const on = typeof checked === "function" ? checked() : !!checked;
      labelEl.textContent = (on ? "✓ " : "") + t(label);
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
    document.querySelectorAll(".menu-item.open").forEach((m) => m.classList.remove("open"));
  }

  private alert(msg: string) {
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal"><div class="modal-title">${t("提示")}</div><div class="modal-body">${msg.replace(/\n/g, "<br/>")}</div><div class="modal-actions"><button class="primary modal-ok">${t("确定")}</button></div></div>`;
    modal.querySelector(".modal-ok")!.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  }

  private async showAbout() {
    let ver = "dev";
    try {
      if (inTauri()) {
        const v = await getVersion();
        if (typeof v === "string" && v) ver = v;
      }
    } catch {
      /* ignore */
    }
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const sections: Array<[string, string]> = [
      [t("about.feat.editing.title"), t("about.feat.editing")],
      [t("about.feat.files.title"), t("about.feat.files")],
      [t("about.feat.remote.title"), t("about.feat.remote")],
      [t("about.feat.tools.title"), t("about.feat.tools")],
      [t("about.feat.reliable.title"), t("about.feat.reliable")],
    ];
    const body = sections
      .map(
        ([title, lines]) =>
          `<div style="font-weight:600;margin:10px 0 2px;">${esc(title)}</div>` +
          lines
            .split("\n")
            .map((l) => `<div>· ${esc(l)}</div>`)
            .join(""),
      )
      .join("");
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:560px;max-width:680px;">
      <div class="modal-title">${esc(t("about.title"))}</div>
      <div class="modal-body" style="line-height:1.8;font-size:13px;max-height:70vh;overflow:auto;">
        <div style="font-size:15px;font-weight:600;margin-bottom:2px;">0xEdit <span style="font-weight:400;color:#888;">v${esc(ver)}</span></div>
        <div style="color:#888;margin-bottom:6px;">${esc(t("about.text"))}</div>
        ${body}
        <div style="color:#888;margin-top:12px;">${esc(t("about.copyright"))}</div>
      </div>
      <div class="modal-actions"><button class="primary modal-ok">${esc(t("确定"))}</button></div>
    </div>`;
    modal.querySelector(".modal-ok")!.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  }

  // ---------------------------------------------------------------- update

  private async checkForUpdate(silent = false) {
    try {
      const update = await checkForUpdate();
      if (!update) {
        if (!silent) this.alert(t("update.none"));
        return;
      }
      const ok = await this.confirmUpdate(t("update.found", { version: update.version }));
      if (!ok) return;
      this.alert(t("update.downloading"));
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      // 静默检查（启动时）：失败不打扰用户，仅保留手动入口的报错提示
      if (!silent) this.alert(t("update.error") + "\n" + String(e));
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

  // 关闭时保存指定文档；无路径的弹"另存为"，取消则返回 false（中止关闭）
  private async saveDocWithDialog(d: Document): Promise<boolean> {
    if (!d.state) return false;
    if (d.path) {
      return this.saveDocument(d);
    }
    let path = "";
    if (inTauri()) {
      try {
        const picked = await dialogSave({ title: "保存文件", defaultPath: d.name });
        if (!picked) return false;
        path = picked;
      } catch {
        return false;
      }
    }
    if (!path) return false;
    d.path = path;
    d.name = path.split(/[\\/]/).pop() || path;
    d.archive = undefined;
    d.remote = undefined;
    const text = d.state.doc.toString();
    d.state = EditorState.create({ doc: text, extensions: this.extForDoc(d) });
    if (this.activeId === d.id && this.view) this.view.setState(d.state);
    const ok = await this.saveDocument(d);
    this.renderTabs();
    this.updateStatus();
    return ok;
  }

  // ---------------------------------------------------------------- toolbar

  private bindToolbar() {
    document.getElementById("toolbar")!.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!btn) return;
      const act = btn.dataset.action;
      this.runAction(act!);
    });
    document.getElementById("md-toolbar")!.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-md]");
      if (!btn) return;
      this.mdFormat(btn.dataset.md!);
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
      case "preview": this.togglePreview(); break;
      case "mode": this.toggleMode(); break;
      case "palette": this.openPalette(); break;
      case "quickopen": void this.openQuickOpen(); break;
      case "split": this.toggleSplit(); break;
      case "print": this.printActive(); break;
      case "cliphist": this.openClipHist(); break;
      case "termFind": this.termFindActive(); break;
      case "zoomIn": this.zoomActive(1); break;
      case "zoomOut": this.zoomActive(-1); break;
      case "tree": this.toggleSidebar(); break;
      case "sidebar": this.toggleSidebar(); break;
      case "theme": this.toggleTheme(); break;
    }
  }

  private exec(cmd: string) {
    const v = this.curView;
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
    const v = this.curView;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    fn(v);
    this.updateStatus();
  }

  private openClipHist() {
    const v = this.curView;
    if (!v) return;
    openClipHistory(v, (m) => { this.statusEls.pos.textContent = m; });
  }

  private convertLE(sep: LineEnding) {
    const v = this.curView;
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

  // 重新打开为：选择字符集，按指定编码重新解码当前文件（参考 UltraEdit 的"重新打开为"）
  private reopenAsDialog() {
    const doc = this.active;
    if (!doc || !doc.path) { this.alert(t("当前文档没有可重新打开的磁盘路径。")); return; }
    const encs = this.encodingOptions();
    const opts = encs.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal" style="min-width:380px;"><div class="modal-title">${t("重新打开为…")}</div><div class="modal-body">
      <div style="margin-bottom:6px;">${t("文件：")}${escapeHtmlFor(doc.name)}</div>
      <div style="margin-bottom:6px;">${t("当前检测编码：")}${doc.encoding}</div>
      ${t("按以下字符集重新解码：")}
      <select id="reopen-enc" style="margin:6px 0 0 0;width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 8px;">${opts}</select>
      <div style="margin-top:6px;font-size:12px;color:var(--fg-dim);">${t("仅改变文件的查看解读，不修改磁盘上的内容。")}</div>
      <div class="modal-actions" style="margin-top:14px;">
        <button data-act="ok" class="primary">${t("重新打开")}</button>
        <button data-act="cancel">${t("取消")}</button>
      </div>
    </div></div>`;
    modal.querySelector('[data-act="ok"]')!.addEventListener("click", async () => {
      const enc = (modal.querySelector("#reopen-enc") as HTMLSelectElement).value;
      modal.remove();
      await this.reopenWithEncoding(enc);
    });
    modal.querySelector('[data-act="cancel"]')!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.remove();
    });
    document.body.appendChild(modal);
  }

  // 按指定编码重新解码当前文档（复用文档标签与位置，仅替换内容解读）
  private async reopenWithEncoding(enc: string) {
    const doc = this.active;
    if (!doc || !doc.path) return;
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
    try {
      const res = await invoke<{ text: string; truncated: boolean; encoding: string; size: number; is_binary: boolean; line_endings: string }>("read_text_file_as", { path: doc.path, encoding: enc });
      doc.encoding = res.encoding;
      doc.isBinary = false;
      doc.mode = "text";
      doc.lineEnding = res.line_endings || "lf";
      doc.size = res.size;
      doc.truncated = res.truncated;
      doc.savedContent = res.text;
      doc.state = EditorState.create({ doc: res.text, extensions: this.extForDoc(doc) });
      if (this.view) this.view.setState(doc.state);
      this.editorEl.classList.remove("hidden");
      this.hexEl.classList.add("hidden");
      this.hexRoot.classList.add("hidden");
      this.emptyStateEl.classList.add("hidden");
      if (this.splitView && this.splitDocId === doc.id) this.openInSplit(doc.id);
      this.renderTabs();
      this.updateStatus();
      this.updateModeButton();
      this.updateColumnButton();
      this.view?.focus();
    } catch (e) {
      this.alert(t("重新打开失败：") + `\n${e}`);
    }
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
    const v = this.curView;
    if (!doc || !v || doc.mode === "hex") return;
    if (isMarkdownDoc(this.docLangPath(doc), doc.name)) {
      // Markdown 文档导出为渲染后的 HTML（可打印/存 PDF）
      await this.exportMarkdown();
      return;
    }
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
    const v = this.curView;
    if (!doc || !v) return;
    if (doc.mode === "hex") { this.alert(t("十六进制模式不支持导出，请切换回文本模式。")); return; }
    if (!isMarkdownDoc(this.docLangPath(doc), doc.name)) {
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
    const v = this.curView;
    if (!doc || !v) return;
    if (doc.mode === "hex") { this.alert(t("十六进制模式不支持导出，请切换回文本模式。")); return; }
    if (!isMarkdownDoc(this.docLangPath(doc), doc.name)) {
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

  // Markdown 预览按钮：非 markdown/hex 置灰，预览开启时高亮
  private syncPreviewBtn() {
    const btn = document.getElementById("btn-preview");
    if (!btn) return;
    const doc = this.active;
    btn.classList.toggle("active", this.previewOn);
    btn.classList.toggle("disabled", !(doc && doc.mode !== "hex" && isMarkdownDoc(this.docLangPath(doc), doc.name)));
  }

  // Markdown 格式工具栏显隐：仅 Markdown 文本文档显示
  private syncMdToolbar() {
    const doc = this.active;
    this.mdToolbarEl.classList.toggle(
      "hidden",
      !(doc && doc.mode !== "hex" && isMarkdownDoc(this.docLangPath(doc), doc.name)),
    );
  }

  // Markdown 格式命令：选中文本包裹/行首前缀，未选中插入模板并定位光标
  private mdFormat(kind: string) {
    const view = this.curView;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const sel = view.state.sliceDoc(from, to);
    const apply = (insert: string, cursor?: number) => {
      const pos = cursor === undefined ? from + insert.length : from + cursor;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: pos } });
      view.focus();
    };
    // 行级前缀：对选区覆盖的整段按行加前缀（i 为行序号）
    const prefix = (pfx: (i: number) => string, keepSelection = false) => {
      const lineA = view.state.doc.lineAt(from);
      const lineB = view.state.doc.lineAt(to);
      const start = lineA.from;
      const end = lineB.to;
      const text = view.state.sliceDoc(start, end);
      const out = text.split("\n").map((l, i) => pfx(i) + l).join("\n");
      view.dispatch({
        changes: { from: start, to: end, insert: out },
        selection: keepSelection ? { anchor: start + out.length } : { anchor: start, head: start + out.length },
      });
      view.focus();
    };
    switch (kind) {
      case "bold":
        if (sel) apply(`**${sel}**`, 2);
        else apply(`****`, 2);
        break;
      case "italic":
        if (sel) apply(`*${sel}*`, 1);
        else apply(`**`, 1);
        break;
      case "strike":
        if (sel) apply(`~~${sel}~~`, 2);
        else apply(`~~~~`, 2);
        break;
      case "code":
        if (sel) apply("`" + sel + "`", 1);
        else apply("``", 1);
        break;
      case "codeblock": {
        const t = sel || "";
        // 光标停在 ``` 后（语言位），输入语言（如 js/python）后 Enter 进入代码区
        apply("```\n" + t + "\n```", 3);
        break;
      }
      case "h1":
      case "h2":
      case "h3": {
        const n = parseInt(kind[1], 10);
        const lineA = view.state.doc.lineAt(from);
        const lineB = view.state.doc.lineAt(to);
        const start = lineA.from;
        const end = lineB.to;
        const text = view.state.sliceDoc(start, end);
        const out = text
          .split("\n")
          .map((l) => l.replace(/^#{1,6}\s*/, ""))
          .map((l) => "#".repeat(n) + " " + l)
          .join("\n");
        view.dispatch({ changes: { from: start, to: end, insert: out }, selection: { anchor: start + out.length } });
        view.focus();
        break;
      }
      case "quote":
        prefix(() => "> ");
        break;
      case "ul":
        prefix(() => "- ");
        break;
      case "ol":
        prefix((i) => `${i + 1}. `);
        break;
      case "task":
        prefix(() => "- [ ] ");
        break;
      case "link": {
        const text = sel || "链接文字";
        apply(`[${text}](url)`, text.length + 3);
        break;
      }
      case "image": {
        const desc = sel || "图片描述";
        apply(`![${desc}](path)`, desc.length + 4);
        break;
      }
      case "table": {
        const ins = "\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n";
        apply(ins, ins.indexOf("|  |") + 2);
        break;
      }
      case "hr":
        apply("\n---\n", 0);
        break;
      case "toc": {
        // 按全文标题生成目录（GitHub 风格锚点），插入到光标处
        const text = view.state.doc.toString();
        const heads: Array<{ level: number; text: string }> = [];
        for (const l of text.split("\n")) {
          const m = l.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
          if (m) heads.push({ level: m[1].length, text: m[2] });
        }
        if (!heads.length) {
          this.alert("当前文档没有标题，无法生成目录。");
          break;
        }
        const anchor = (s: string) =>
          s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
        const toc = heads
          .map((h) => `${"  ".repeat(h.level - 1)}- [${h.text}](#${anchor(h.text)})`)
          .join("\n");
        apply("\n" + toc + "\n", 1);
        break;
      }
      default:
        break;
    }
  }

  // Markdown 内粘贴/拖拽图片 → 自动保存到当前文件目录 assets/ 并插入链接
  private mdInsertImageFile(file: File, nameHint: string) {
    const doc = this.active;
    if (!doc || !doc.path || doc.mode === "hex") return;
    const slash = doc.path.lastIndexOf("/");
    const dir = slash >= 0 ? doc.path.slice(0, slash) : ".";
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const fileName = `img-${Date.now()}-${Math.floor(Math.random() * 1000)}.${ext}`;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      const b64 = reader.result.split(",")[1];
      void invoke("write_binary_file", { path: `${dir}/assets/${fileName}`, dataBase64: b64 })
        .then(() => {
          const v = this.curView;
          if (!v) return;
          const { from, to } = v.state.selection.main;
          const insert = `![${nameHint || fileName}](assets/${fileName})`;
          v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
          v.focus();
          this.tree.refresh();
        })
        .catch((e) => this.alert(t("保存图片失败：") + `\n${e}`));
    };
    reader.readAsDataURL(file);
  }

  private mdPasteImage(e: ClipboardEvent): boolean {
    const doc = this.active;
    if (!doc || doc.mode === "hex" || !isMarkdownDoc(this.docLangPath(doc), doc.name)) return false;
    const items = e.clipboardData?.items;
    if (!items) return false;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (!f) continue;
        e.preventDefault();
        this.mdInsertImageFile(f, f.name.replace(/\.[^.]+$/, ""));
        return true;
      }
    }
    return false;
  }

  private mdDropImage(e: DragEvent): boolean {
    const doc = this.active;
    if (!doc || doc.mode === "hex" || !isMarkdownDoc(this.docLangPath(doc), doc.name)) return false;
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return false;
    const img = Array.from(files).find((f) => f.type.startsWith("image/"));
    if (!img) return false;
    e.preventDefault();
    this.mdInsertImageFile(img, img.name.replace(/\.[^.]+$/, ""));
    return true;
  }

  // 预览中勾选任务列表 → 回写编辑区对应行（- [ ] ↔ - [x]）
  private applyTaskToggle(line: number, checked: boolean) {
    const v = this.curView;
    const doc = this.active;
    if (!v || !doc || doc.mode === "hex") return;
    if (line < 1 || line > v.state.doc.lines) return;
    const ln = v.state.doc.line(line);
    const m = ln.text.match(/^(\s*[-*])\s*\[([ xX])\]/);
    if (!m) return;
    const marker = checked ? "x" : " ";
    const insert = `${m[1]} [${marker}]${ln.text.slice(m[0].length)}`;
    v.dispatch({ changes: { from: ln.from, to: ln.to, insert } });
    v.focus();
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
      if (theme === "light") this.applyTheme("default-light");
      else if (theme === "dark") this.applyTheme("default-dark");
      else if (theme && THEMES[theme]) this.applyTheme(theme);
      else this.applyTheme("default-dark");
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
    const curFont = localStorage.getItem("uec.font") || "13px";
    const storedTheme = localStorage.getItem("uec.theme");
    const curTheme = storedTheme === "dark" ? "default-dark" : storedTheme === "light" ? "default-light" : storedTheme || "default-dark";
    const themeOptions = Object.entries(THEMES).map(([id, t]) =>
      `<option value="${id}" ${curTheme === id ? "selected" : ""}>${t.name}</option>`
    ).join("");
    const rows = [
      ["新建", "new", "n"], ["打开", "open", "o"], ["保存", "save", "s"], ["另存为", "saveAs", "s"],
      ["查找", "find", "f"], ["替换", "replace", "f"], ["跳转行", "goto", "g"], ["关闭标签", "closeTab", "w"],
      ["侧边栏", "sidebar", "b"], ["列模式", "column", "l"], ["命令面板", "palette", "p"],
      ["快速打开文件", "quickopen", "p"],
      ["拆分窗口", "split", "\\"], ["打印", "print", ""], ["剪贴板历史", "cliphist", "v"], ["文本/十六进制", "mode", "m"],
      ["终端搜索", "termFind", "f"], ["字号放大", "zoomIn", "="], ["字号缩小", "zoomOut", "-"],
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
          ${themeOptions}
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
      this.applyTheme(theme);
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
    const v = this.curView;
    if (!doc || !v || doc.mode === "hex") return;
    const l = Math.max(1, Math.min(line, v.state.doc.lines));
    const ln = v.state.doc.line(l);
    v.dispatch({
      selection: { anchor: ln.from },
      effects: [EditorView.scrollIntoView(ln.from, { y: "center" })],
    });
  }

  private async openRemoteDoc(tmp: string, proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string) {
    // 去重：同一远程文件已打开时直接激活，避免重复下载与重复 tab
    const existing = [...this.docs.values()].find(
      (d) => d.remote && d.remote.id === id && d.remote.path === remotePath && d.mode === "text"
    );
    if (existing) {
      this.activate(existing.id);
      return;
    }
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
      doc.savedContent = res.text;
      doc.state = EditorState.create({ doc: res.text, extensions: this.extForDoc(doc) });
    }
    this.addDoc(doc);
  }

  // 归档内条目 → 新 tab 打开（可编辑，⌘S 回写归档；本地归档就地重建，远程归档重建后回写服务器）
  private async openArchiveDoc(
    tmp: string,
    kind: string,
    entry: string,
    archiveName: string,
    proto?: "ftp" | "sftp" | "ftps",
    id?: string,
    remotePath?: string,
  ) {
    // 去重：同一归档的同一条目已打开则激活
    const existing = [...this.docs.values()].find(
      (d) => d.archive && d.archive.tmpPath === tmp && d.archive.entry === entry && d.mode === "text"
    );
    if (existing) {
      this.activate(existing.id);
      return;
    }
    let res;
    try {
      res = await invoke<{ text: string; is_binary: boolean; truncated: boolean; size: number }>(
        "archive_read", { path: tmp, entryName: entry, maxBytes: 32 * 1024 * 1024 });
    } catch (e) {
      this.alert(t("打开失败：") + `\n${e}`);
      return;
    }
    if (res.is_binary) {
      this.alert(t("归档内该条目为二进制内容，无法在编辑器中打开"));
      return;
    }
    const doc: Document = {
      id: uid(),
      path: tmp,
      name: `${entry.split("/").pop() || entry} [${archiveName}]`,
      encoding: "utf-8",
      lineEnding: "lf",
      isBinary: false,
      mode: "text",
      dirty: false,
      size: res.size,
      truncated: res.truncated,
      remote: proto && id && remotePath ? { proto, id, path: remotePath } : undefined,
      archive: { kind, entry, tmpPath: tmp, archiveName },
    };
    doc.savedContent = res.text;
    doc.state = EditorState.create({ doc: res.text, extensions: this.extForDoc(doc) });
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
      c("快速打开文件…", "文件", () => void this.openQuickOpen()),
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
      c("重新打开为…", "文件", () => this.reopenAsDialog()),
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
      c("宏管理…", "宏", () => { const v = this.curView; if (v) macroManagerDialog(v, (m) => { this.statusEls.pos.textContent = m; }); }),
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

  // ⌘P 快速打开文件：扫描当前目录 + 最近文件 + 已打开标签
  private async openQuickOpen() {
    const files: QuickOpenFile[] = [];
    const seen = new Set<string>();
    const add = (p: string) => {
      if (seen.has(p)) return;
      seen.add(p);
      files.push({ path: p, name: p.split("/").pop() || p });
    };
    for (const d of this.docs.values()) if (d.path) add(d.path);
    for (const p of getRecent()) add(p);
    const root = this.tree.getCurDir();
    if (root) {
      try {
        await this.scanQuickDir(root, files, seen, 0);
      } catch {
        /* ignore */
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    this.quickOpen.open(files, (f) => {
      void this.openFile(f.path);
    });
  }

  private async scanQuickDir(dir: string, files: QuickOpenFile[], seen: Set<string>, depth: number) {
    if (depth > 6 || files.length > 4000) return;
    const entries = await invoke<FileEntry[]>("list_dir", { path: dir }).catch(() => []);
    for (const e of entries) {
      if (!this.showHidden && e.name.startsWith(".")) continue;
      if (e.is_dir) {
        await this.scanQuickDir(e.path, files, seen, depth + 1);
      } else if (!seen.has(e.path)) {
        seen.add(e.path);
        files.push({ path: e.path, name: e.name });
      }
    }
  }

  private gotoLineDialog() {
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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

  // 分屏（右侧）编辑器扩展：可编辑版（与主视图同款高亮/行号/折叠，无主视图专属监听）
  private splitExt(doc: Document): import("@codemirror/state").Extension[] {
    const langPath = this.docLangPath(doc);
    const lang = langPath ? langForPath(langPath) : { ext: [], name: t("纯文本") };
    const base: import("@codemirror/state").Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      this.syntaxCompartment.of(highlightForTheme()),
      highlightSelectionMatches(),
      searchHighlight(),
      foldGutter(),
      wrapCompartment.of(doc.wrap ? EditorView.lineWrapping : []),
      wsCompartment.of(doc.showWs ? [highlightWhitespace()] : []),
      langCompartment.of(isMarkdownDoc(this.docLangPath(doc), doc.name) ? markdown({ base: markdownLanguage }) : lang.ext),
      themeBase(),
    ];
    if (lang.ext) base.push(lang.ext);
    return base;
  }

  private ensureSplitView() {
    if (this.splitView) return;
    this.splitPanel.classList.remove("hidden");
    this.mainPanel.classList.add("split-mode");
    // 无标题条：右栏内容与左栏从同一水平线开始（关闭分屏用 ⌘\ 或菜单）
    this.splitPanel.innerHTML = `<div id="split-host"></div>`;
    const host = this.splitPanel.querySelector("#split-host")!;
    this.splitView = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions: [] }) });
  }

  private renderSplit(doc: Document) {
    if (!this.splitView) return;
    this.splitView.setState(EditorState.create({
      doc: doc.state ? doc.state.doc : "",
      // 可编辑 + 右侧编辑实时同步回主视图（splitSyncing 防循环）
      extensions: [
        ...this.splitExt(doc),
        EditorView.updateListener.of((u) => this.onSplitUpdate(u)),
      ],
    }));
  }

  // 右侧分屏编辑 → 整体同步回主视图（主视图 updateListener 会同步 doc.state/dirty/预览）
  private onSplitUpdate(u: import("@codemirror/view").ViewUpdate) {
    if (!this.splitView || !u.docChanged || this.splitSyncing) return;
    const main = this.view;
    if (!main) return;
    this.splitSyncing = true;
    try {
      main.dispatch({ changes: { from: 0, to: main.state.doc.length, insert: u.state.doc.toString() } });
    } finally {
      this.splitSyncing = false;
    }
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

  // 当前激活编辑器视图（平铺时=激活格，单格=主视图）
  private get curView(): EditorView | null {
    if (this.tileMode) {
      const cell = this.activeId ? this.tileCells.get(this.activeId) : null;
      return cell?.view ?? null;
    }
    return this.view;
  }

  // ---------------------------------------------------------------- tile (多标签平铺)

  private tileTags(dir: "v" | "h") {
    // 混合平铺：文本文档 + 终端 tab（文档在前、终端按打开顺序）
    const items: Array<{ kind: "doc"; id: string; doc: Document } | { kind: "term"; id: string; term: RemoteTerm }> = [];
    for (const id of this.tabOrder) {
      const doc = this.docs.get(id);
      if (doc && doc.mode === "text") items.push({ kind: "doc", id, doc });
    }
    for (const id of this.termOrder) {
      const term = this.terms.get(id);
      if (term) items.push({ kind: "term", id, term });
    }
    if (items.length < 2) {
      this.alert(t("至少需要打开 2 个标签才能平铺。"));
      return;
    }
    if (this.tileMode) {
      // 已在平铺：仅切换方向/重排，保留格子与格内预览状态
      this.tileMode = dir;
      this.layoutTiles(this.tileCells.size + this.termTileCells.size);
      return;
    }
    const list = items.slice(0, 12); // 上限 12 格，超出留在标签栏
    this.tileMode = dir;
    this.tileCells.clear();
    this.termTileCells.clear();
    this.tileArea.innerHTML = "";
    if (this.previewOn) this.closePreview(true);
    this.activeTermId = null;
    this.hexEl.classList.add("hidden");
    this.hexRoot.classList.add("hidden");
    this.editorEl.classList.add("hidden");
    this.emptyStateEl.classList.add("hidden");
    // 平铺时顶部集中标签栏隐藏（格子标题条即标签，SecureCRT 风格）
    this.tabbarEl.classList.add("hidden");
    this.tileArea.classList.remove("hidden");
    for (const item of list) {
      if (item.kind === "doc") {
        const doc = item.doc;
        const cell = new TileCell(
          doc,
          (id) => this.activateTileCell(id),
          (id) => void this.closeTab(id),
          (x, y, d) => this.showTabMenu(x, y, d as Document),
        );
        this.tileCells.set(doc.id, cell);
        this.tileArea.appendChild(cell.el);
      } else {
        const term = item.term;
        const cell = new TerminalTileCell(
          term.id,
          term.title,
          term.el,
          (id) => this.activateTileTerm(id),
          (id) => this.closeTerm(id),
          (x, y) => this.showTermMenu(x, y, term.id),
        );
        this.termTileCells.set(term.id, cell);
        this.tileArea.appendChild(cell.el);
      }
    }
    // 终端的 xterm 已全部迁入格子，原终端区域隐藏
    this.termArea.classList.add("hidden");
    this.layoutTiles(list.length);
    this.updateTileMore(items.length, list.length);
    const curTerm = this.activeTermId ? this.terms.get(this.activeTermId) : null;
    const curDoc = this.docs.get(this.activeId ?? "");
    const target =
      curTerm && this.termTileCells.has(curTerm.id)
        ? curTerm.id
        : curDoc && curDoc.mode === "text" && this.tileCells.has(curDoc.id)
          ? curDoc.id
          : list[0].id;
    if (this.termTileCells.has(target)) this.activateTileTerm(target);
    else this.activateTileCell(target);
  }

  // 平铺模式下激活终端格子（SSH 会话继续，远程目录树联动）
  private activateTileTerm(id: string) {
    if (!this.termTileCells.has(id)) {
      // 未入格的终端（超出平铺上限等）：合并回单格并正常激活
      this.mergeTags();
      this.activateTerm(id);
      return;
    }
    const sid = this.termSite.get(id);
    if (sid) this.remote.activateSession(sid);
    this.activeId = null;
    this.activeTermId = id;
    this.tileCells.forEach((c, cid) => c.el.classList.toggle("active", cid === id));
    this.termTileCells.forEach((c, cid) => c.el.classList.toggle("active", cid === id));
    const term = this.terms.get(id);
    if (term) {
      this.statusEls.path.textContent = term.title;
      this.statusEls.lang.textContent = "";
      this.updateStatus();
    }
    requestAnimationFrame(() => term?.focus());
  }

  // 平铺数量超过上限时的提示条（未入格标签需合并后访问）
  private updateTileMore(total: number, shown: number) {
    this.tileArea.querySelector(".tile-more")?.remove();
    if (total > shown) {
      const bar = document.createElement("div");
      bar.className = "tile-more";
      bar.textContent = t("共 {n} 个标签，已平铺前 {m} 个，其余标签合并后查看", { n: total, m: shown });
      bar.addEventListener("click", () => this.mergeTags());
      this.tileArea.insertAdjacentElement("beforebegin", bar);
    }
  }

  private layoutTiles(n: number) {
    if (this.tileMode === "h") {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.max(1, Math.ceil(n / cols));
      this.tileArea.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      this.tileArea.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    } else {
      const rows = Math.max(1, Math.ceil(Math.sqrt(n)));
      const cols = Math.max(1, Math.ceil(n / rows));
      this.tileArea.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      this.tileArea.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    }
  }

  private activateTileCell(id: string) {
    if (!this.tileCells.has(id)) {
      // 未入格的标签（超出平铺上限等）：合并回单格并正常激活
      this.mergeTags();
      this.activate(id);
      return;
    }
    const prevId = this.activeId;
    if (prevId && prevId !== id) {
      const prevCell = this.tileCells.get(prevId);
      if (prevCell && this.docs.get(prevId)) {
        this.docs.get(prevId)!.scrollTop = prevCell.view.scrollDOM.scrollTop;
      }
    }
    this.activeId = id;
    this.activeTermId = null;
    this.tileCells.forEach((c, cid) => c.el.classList.toggle("active", cid === id));
    this.termTileCells.forEach((c) => c.el.classList.remove("active"));
    const doc = this.docs.get(id);
    if (doc) {
      const langPath = this.docLangPath(doc);
      this.statusEls.lang.textContent = langPath ? langForPath(langPath).name : t("纯文本");
      this.statusEls.path.textContent = doc.path || "";
      this.updateStatus();
      this.syncMdToolbar();
    }
    this.renderTabs();
    const cell = this.tileCells.get(id);
    if (cell) requestAnimationFrame(() => cell.focus());
  }

  private mergeTags() {
    if (!this.tileMode) return;
    const active = this.activeId;
    if (active) {
      const cell = this.tileCells.get(active);
      const doc = this.docs.get(active);
      if (cell && doc) doc.scrollTop = cell.view.scrollDOM.scrollTop;
    }
    // 终端格子：term.el 迁回终端区域（display 先复位，由激活分支决定显隐）
    this.termTileCells.forEach((cell, tid) => {
      const term = this.terms.get(tid);
      if (term) {
        term.el.style.display = "none";
        this.termArea.appendChild(term.el);
      }
      cell.destroy();
    });
    this.termTileCells.clear();
    this.tileCells.forEach((c) => c.destroy());
    this.tileCells.clear();
    this.tileMode = null;
    this.tileArea.classList.add("hidden");
    this.tileArea.innerHTML = "";
    this.tileArea.querySelector(".tile-more")?.remove();
    document.querySelector(".tile-more")?.remove();
    this.tabbarEl.classList.remove("hidden");
    // 合并后优先恢复终端视图（激活的终端还在则继续显示）
    const nextTerm =
      (this.activeTermId && this.terms.has(this.activeTermId)
        ? this.activeTermId
        : this.termOrder.find((i) => this.terms.has(i))) ?? null;
    if (nextTerm) {
      this.editorEl.classList.add("hidden");
      this.hexEl.classList.add("hidden");
      this.hexRoot.classList.add("hidden");
      this.emptyStateEl.classList.add("hidden");
      this.mdToolbarEl.classList.add("hidden");
      this.termArea.classList.remove("hidden");
      for (const [tid, term] of this.terms) {
        term.el.style.display = tid === nextTerm ? "" : "none";
      }
      this.renderTabs();
      const term = this.terms.get(nextTerm);
      requestAnimationFrame(() => window.setTimeout(() => term?.focus(), 60));
      this.updateStatus();
      return;
    }
    this.termArea.classList.add("hidden");
    this.editorEl.classList.remove("hidden");
    const next = this.active && this.active.mode === "text"
      ? this.active.id
      : (this.tabOrder.find((i) => this.docs.get(i)?.mode === "text") ?? null);
    if (next) {
      this.activate(next);
    } else {
      this.closePreview();
      this.hexEl.classList.add("hidden");
      this.emptyStateEl.classList.remove("hidden");
      this.renderEmptyRecent();
      this.statusEls.path.textContent = "";
      this.statusEls.pos.textContent = "Ln 1, Col 1";
      this.statusEls.lang.textContent = "";
      this.statusEls.encoding.textContent = "";
      this.statusEls.size.textContent = "";
    }
    this.renderTabs();
  }

  private toggleSplit() {
    if (this.tileMode) this.mergeTags();
    if (this.splitView) {
      this.destroySplit();
      return;
    }
    // 分屏与 Markdown 预览共用右侧空间，互斥：开分屏先关预览
    if (this.previewOn) this.closePreview();
    const doc = this.active;
    if (!doc || doc.mode === "hex") { this.alert(t("十六进制模式不支持分屏，请切换回文本模式。")); return; }
    if (!this.view) return;
    this.ensureSplitView();
    this.splitDocId = doc.id;
    this.renderSplit(doc);
  }

  private togglePreview() {
    if (this.tileMode) {
      const doc = this.active;
      const cell = this.activeId ? this.tileCells.get(this.activeId) : null;
      if (!cell || !doc || doc.mode === "hex") {
        this.alert(t("十六进制模式不支持预览，请切换回文本模式。"));
        return;
      }
      if (!isMarkdownDoc(this.docLangPath(doc), doc.name)) {
        this.alert(t("当前文件不是 Markdown，无法预览。"));
        return;
      }
      cell.togglePreview();
      return;
    }
    if (this.previewOn) {
      this.closePreview();
      return;
    }
    const doc = this.active;
    if (!doc || doc.mode === "hex") {
      this.alert(t("十六进制模式不支持预览，请切换回文本模式。"));
      return;
    }
    if (!isMarkdownDoc(this.docLangPath(doc), doc.name)) {
      this.alert(t("当前文件不是 Markdown，无法预览。"));
      return;
    }
    // 预览与分屏共用右侧空间，互斥：开预览先关分屏
    if (this.splitView) this.destroySplit();
    this.openPreview();
  }

  private openPreview() {
    const view = this.view;
    if (!view) return;
    this.previewPanel.classList.remove("hidden");
    this.preview = new MarkdownPreview(this.previewPanel);
    this.preview.onTaskToggle = (line, checked) => this.applyTaskToggle(line, checked);
    this.preview.attach(view);
    this.previewOn = true;
    this.prefPreview = true;
    try { localStorage.setItem("uec.preview", "1"); } catch { /* ignore */ }
    this.refreshPreview();
    this.syncPreviewBtn();
  }

  private closePreview(keepPref = false) {
    if (this.preview) {
      this.preview.destroy();
      this.preview = null;
    }
    this.previewPanel.classList.add("hidden");
    this.previewOn = false;
    if (!keepPref) {
      this.prefPreview = false;
      try { localStorage.setItem("uec.preview", "0"); } catch { /* ignore */ }
    }
    this.syncPreviewBtn();
  }

  private refreshPreview() {
    if (!this.previewOn || !this.preview) return;
    const doc = this.active;
    if (!doc || !isMarkdownDoc(this.docLangPath(doc), doc.name)) {
      this.closePreview(true); // 临时离开预览文件：保留预览意图，切回时自动恢复
      return;
    }
    const src = this.view ? this.view.state.doc.toString() : "";
    this.preview.show(src);
    // 渲染后按当前光标位置对齐预览
    const st = this.view?.state;
    if (st) {
      const head = st.selection.main.head;
      this.preview.syncCursor(st.doc.lineAt(head).number, st.doc.lines);
    }
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
      this.markSaved(doc);
      doc.size = new TextEncoder().encode(text).length;
      await invoke("clear_recovery", { key: doc.id }).catch(() => {});
      return true;
    } catch {
      return false;
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
    const v = this.curView;
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
    const v = this.curView;
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
    const v = this.curView;
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
    if (this.tileMode) this.mergeTags();
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
      const langPath = this.docLangPath(doc);
      this.statusEls.lang.textContent = langPath ? langForPath(langPath).name : t("纯文本");
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
      sb.style.width = "0px";
      try { localStorage.setItem("uec.sidebar.collapsed", "1"); } catch { /* ignore */ }
    } else {
      const saved = parseInt(localStorage.getItem("uec.sidebar.w") || "", 10);
      sb.style.width = (saved > 40 ? saved : 220) + "px";
      try { localStorage.removeItem("uec.sidebar.collapsed"); } catch { /* ignore */ }
    }
    const btn = document.querySelector<HTMLElement>('[data-action="tree"]');
    btn?.classList.toggle("active", !collapsed);
  }

  private restoreSidebarCollapsed() {
    const sb = document.getElementById("sidebar")!;
    const collapsed = localStorage.getItem("uec.sidebar.collapsed") === "1";
    if (collapsed) {
      sb.classList.add("collapsed");
      sb.style.width = "0px";
    }
    // 按钮高亮与侧边栏实际状态同步（展开=active 带色，收起=不高亮）
    const btn = document.querySelector<HTMLElement>('[data-action="tree"]');
    btn?.classList.toggle("active", !collapsed);
  }

  private applyTheme(id: string) {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    root.classList.remove("dark");
    if (id === "default-dark") {
      root.classList.add("dark");
    } else if (id !== "default-light") {
      root.setAttribute("data-theme", id);
    }
    localStorage.setItem("uec.theme", id);
    // 已打开的远程终端同步跟随主题配色
    this.terms.forEach((tm) => tm.updateTheme());
    const btn = document.querySelector<HTMLElement>('[data-action="theme"]');
    btn?.classList.toggle("active", isDarkTheme(id));
    // 深/浅主题切换时同步替换所有文档与分屏的语法高亮配色
    const hl = this.syntaxCompartment.reconfigure(highlightForTheme());
    for (const d of this.docs.values()) {
      if (d.state) d.state = d.state.update({ effects: hl }).state;
    }
    const act = this.active;
    if (act && act.state) this.view?.setState(act.state);
    this.splitView?.dispatch({ effects: hl });
    this.view?.requestMeasure();
  }

  private toggleTheme() {
    const cur = localStorage.getItem("uec.theme") || "default-dark";
    const pair = THEMES[cur]?.pair || "default-dark";
    this.applyTheme(pair);
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
      if (saveAs) {
        // 另存为本地后脱离归档/远程上下文
        doc.archive = undefined;
        doc.remote = undefined;
      }
      if (doc.mode === "text" && !doc.isBinary) {
        const text = doc.state!.doc.toString();
        doc.state = EditorState.create({ doc: text, extensions: this.extForDoc(doc) });
        const cv = this.curView;
        if (cv) cv.setState(doc.state);
        if (this.view && this.view !== cv) this.view.setState(doc.state);
      }
    }
    try {
      // 归档条目保存：重建归档并回写远程（不走本地临时文件覆盖）
      if (doc.archive) {
        const text = doc.state!.doc.toString();
        await invoke("archive_update", { path: doc.archive.tmpPath, entryName: doc.archive.entry, newContent: text });
        if (doc.remote) {
          if (doc.remote.proto === "sftp") {
            await invoke("sftp_upload", { id: doc.remote.id, localPath: doc.archive.tmpPath, remotePath: doc.remote.path, taskId: newTransferId() });
          } else {
            await invoke("ftp_upload", { id: doc.remote.id, localPath: doc.archive.tmpPath, remoteName: doc.archive.archiveName, taskId: newTransferId() });
          }
        }
        this.markSaved(doc);
        doc.size = new TextEncoder().encode(text).length;
        this.renderTabs();
        this.updateStatus();
        return true;
      }
      if (doc.mode === "hex") {
        await this.hex.save();
        doc.hexBytes = this.hex.getBytes();
        doc.dirty = false;
      } else {
        const text = doc.state!.doc.toString();
        await invoke("save_text_file", { path, text, encoding: doc.encoding, line_ending: doc.lineEnding, backup: true });
        this.markSaved(doc);
        doc.size = new TextEncoder().encode(text).length;
      }
      if (doc.remote) {
        try {
          if (doc.remote.proto === "sftp") {
            await invoke("sftp_upload", { id: doc.remote.id, localPath: path, remotePath: doc.remote.path, taskId: newTransferId() });
          } else {
            await invoke("ftp_upload", { id: doc.remote.id, localPath: path, taskId: newTransferId() });
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
      doc.savedContent = text;
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
    if (this.tileMode) {
      const cell = this.tileCells.get(id);
      cell?.destroy();
      this.tileCells.delete(id);
      if (this.tileCells.size + this.termTileCells.size <= 1) {
        // 剩 0/1 格自动合并回单格（mergeTags 内部激活剩余的文档/终端或进入空状态）
        this.mergeTags();
        this.renderTabs();
        return;
      }
      this.layoutTiles(this.tileCells.size + this.termTileCells.size);
      const total =
        [...this.docs.values()].filter((d) => d.mode === "text").length + this.terms.size;
      this.updateTileMore(total, this.tileCells.size + this.termTileCells.size);
      if (this.activeId === id) {
        const keys = [...this.tileCells.keys()];
        if (keys.length) this.activateTileCell(keys[keys.length - 1]);
        else {
          const tKeys = [...this.termTileCells.keys()];
          if (tKeys.length) this.activateTileTerm(tKeys[tKeys.length - 1]);
        }
      }
      this.renderTabs();
      return;
    }
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

  // ---------------------------------------------------------------- remote term

  openTerminal(params: TermParams, initialDir?: string, siteId?: string) {
    const accountName = siteId ? this.remote.getSiteName(siteId) : params.host;
    const term = new RemoteTerm(params.host, params.username, accountName);
    this.terms.set(term.id, term);
    if (siteId) this.termSite.set(term.id, siteId);
    this.termOrder.push(term.id);
    term.onExit = () => this.renderTabs();
    // 远程 shell 标题（如 root@hh6:~）只更新悬停提示，不覆盖固定 tab 名
    term.onTitle = (title) => {
      if (!title) return;
      term.remoteTitle = title;
      const tab = this.tabbarEl.querySelector<HTMLElement>(`[data-tab="${term.id}"] .tab-name`);
      if (tab) tab.title = title;
      const cell = this.termTileCells.get(term.id);
      if (cell) {
        const t = cell.el.querySelector<HTMLElement>(".tile-title");
        if (t) t.title = title;
      }
    };
    this.termArea.appendChild(term.el);
    void term.start({ ...params, initialDir });
    this.renderTabs();
    this.activateTerm(term.id);
  }

  // 关闭某台服务器对应的全部终端（远程会话断开时联动）
  private closeTermsBySite(siteId: string) {
    for (const [tid, sid] of [...this.termSite]) {
      if (sid === siteId) this.closeTerm(tid);
    }
  }

  private activateTerm(id: string) {
    if (this.tileMode) this.mergeTags();
    if (this.previewOn) this.closePreview(true);
    // 终端切换联动：远程目录树跟随当前终端对应的服务器会话
    const sid = this.termSite.get(id);
    if (sid) this.remote.activateSession(sid);
    this.activeId = null;
    this.activeTermId = id;
    this.editorEl.classList.add("hidden");
    this.hexEl.classList.add("hidden");
    this.hexRoot.classList.add("hidden");
    this.emptyStateEl.classList.add("hidden");
    this.mdToolbarEl.classList.add("hidden");
    this.termArea.classList.remove("hidden");
    for (const [tid, term] of this.terms) {
      term.el.style.display = tid === id ? "" : "none";
    }
    this.renderTabs();
    const term = this.terms.get(id);
    requestAnimationFrame(() => window.setTimeout(() => term?.focus(), 60));
    this.updateStatus();
  }

  private termFindActive() {
    const term = this.activeTermId ? this.terms.get(this.activeTermId) : null;
    term?.showFind();
  }

  private termZoomActive(delta: number) {
    const term = this.activeTermId ? this.terms.get(this.activeTermId) : null;
    if (!term) return;
    if (delta > 0) term.zoomIn();
    else term.zoomOut();
  }

  // ⌘+/⌘- 字号调整：终端激活调终端字号，否则调编辑器字号（10–24px，持久化）
  private zoomActive(delta: number) {
    if (this.activeTermId) {
      this.termZoomActive(delta);
      return;
    }
    const root = document.documentElement;
    const cur = parseInt(getComputedStyle(root).getPropertyValue("--ed-font"), 10) || 13;
    const next = Math.min(24, Math.max(10, cur + delta));
    root.style.setProperty("--ed-font", `${next}px`);
    localStorage.setItem("uec.font", `${next}px`);
  }

  private closeTerm(id: string) {
    const term = this.terms.get(id);
    if (!term) return;
    const siteId = this.termSite.get(id);
    term.dispose();
    this.terms.delete(id);
    this.termSite.delete(id);
    this.termOrder = this.termOrder.filter((x) => x !== id);
    if (this.tileMode) {
      const cell = this.termTileCells.get(id);
      cell?.destroy();
      this.termTileCells.delete(id);
      if (this.activeTermId === id) this.activeTermId = null;
      if (this.tileCells.size + this.termTileCells.size <= 1) {
        // 剩 0/1 格自动合并（mergeTags 会激活剩余文档或终端）
        this.mergeTags();
        this.renderTabs();
      } else {
        this.layoutTiles(this.tileCells.size + this.termTileCells.size);
        const total =
          [...this.docs.values()].filter((d) => d.mode === "text").length + this.terms.size;
        this.updateTileMore(total, this.tileCells.size + this.termTileCells.size);
        if (this.activeTermId === null) {
          const tKeys = [...this.termTileCells.keys()];
          if (tKeys.length) this.activateTileTerm(tKeys[tKeys.length - 1]);
          else {
            const dKeys = [...this.tileCells.keys()];
            if (dKeys.length) this.activateTileCell(dKeys[dKeys.length - 1]);
          }
        }
        this.renderTabs();
      }
      // 该服务器最后一个终端关闭 → 联动断开会话
      if (siteId && ![...this.termSite.values()].includes(siteId)) {
        void this.remote.disconnect(siteId);
      }
      return;
    }
    if (this.activeTermId === id) {
      this.activeTermId = null;
      if (this.termOrder.length) {
        this.activateTerm(this.termOrder[this.termOrder.length - 1]);
      } else if (this.docs.size) {
        const last = [...this.docs.values()].pop()!;
        this.activate(last.id);
      } else {
        this.termArea.classList.add("hidden");
        this.editorEl.classList.add("hidden");
        this.hexEl.classList.add("hidden");
        this.emptyStateEl.classList.remove("hidden");
        this.renderEmptyRecent();
      }
    }
    this.renderTabs();
    // 该服务器最后一个终端关闭 → 联动断开会话（目录树/列表同步，MobaXterm session 语义）
    if (siteId && ![...this.termSite.values()].includes(siteId)) {
      void this.remote.disconnect(siteId);
    }
  }

  private onHexDirty() {    const doc = this.active;
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
      preview: { key: "e", shift: true },
      palette: { key: "p", shift: true },
      quickopen: { key: "p" },
      split: { key: "\\" },
      cliphist: { key: "v", shift: true },
      mode: { key: "m" },
      print: { key: "" },
      termFind: { key: "f" },
      zoomIn: { key: "=", shift: true },
      zoomOut: { key: "-" },
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
    // 兼容不同键盘布局/输入法：⌘+ 的 key 可能是 "=" 或 "+"，⌘- 可能是 "-" 或 "_"
    const normKey = (kk: string) => (kk === "+" ? "=" : kk === "_" ? "-" : kk);
    window.addEventListener("resize", () => this.refreshTabMore());
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) {
        // 系统/WebView 可能抢先处理 ⌘+/⌘-（页面缩放）：这里接管为字号调整。
        // 但 CodeMirror keymap 已处理的 ⌘-/⇧⌘-（编辑位置跳转）不再当作缩小，避免双触发。
        const kk = normKey(e.key.toLowerCase());
        if ((e.metaKey || e.ctrlKey) && kk === "=") {
          e.preventDefault();
          this.zoomActive(1);
        } else if ((e.metaKey || e.ctrlKey) && (kk === "-" || kk === "_")) {
          const inEditor = !!(e.target as HTMLElement)?.closest?.(".cm-editor");
          if (!inEditor) {
            e.preventDefault();
            this.zoomActive(-1);
          }
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = normKey(e.key.toLowerCase());
      if (!mod) {
        if (e.key === "F3") {
          e.preventDefault();
          if (e.shiftKey) this.exec("findPrev");
          else this.exec("findNext");
        }
        return;
      }
      // 终端激活时优先匹配终端动作（xterm 聚焦在隐藏 textarea，不受下方输入框保护限制）
      const termActive = this.activeTermId != null;
      if (termActive) {
        const allowed = ["closeTab", "sidebar", "palette", "quickopen", "new", "open", "mode", "termFind", "zoomIn", "zoomOut"];
        for (const a of allowed) {
          const b = this.shortcutBinding(a);
          // 放大/缩小放宽 shift 与键值：⌘=、⌘+、⌘Shift+=、⌘-、⌘Shift+-、小键盘 + 均可
          const compat =
            (a === "zoomIn" && (k === "=" || k === "+")) || (a === "zoomOut" && k === "-");
          if (b && b.key === k && (b.shift === e.shiftKey || compat)) {
            e.preventDefault();
            this.runAction(a);
            return;
          }
        }
        return;
      }
      const t = e.target as HTMLElement;
      // 在文件中查找/替换（⌥⌘F / ⌥⌘H）：带 Alt 修饰，输入框聚焦时也可用
      if (e.altKey && k === "f") { e.preventDefault(); this.openFileSearch(false); return; }
      if (e.altKey && k === "h") { e.preventDefault(); this.openFileSearch(true); return; }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
        return;
      }
      const actions = ["new", "open", "save", "saveAs", "find", "replace", "goto", "closeTab", "sidebar", "column", "preview", "palette", "quickopen", "split", "cliphist", "mode", "print", "zoomIn", "zoomOut"] as const;
      for (const a of actions) {
        const b = this.shortcutBinding(a);
        // 放大/缩小放宽 shift 与键值（同终端分支）
        const compat =
          (a === "zoomIn" && (k === "=" || k === "+")) || (a === "zoomOut" && k === "-");
        if (b && b.key === k && (b.shift === e.shiftKey || compat)) {
          e.preventDefault();
          this.runAction(a);
          return;
        }
      }
    });
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return;
      const menu = document.querySelector<HTMLElement>(".dropdown-menu");
      if (e.key === "Escape") {
        // 统一 ESC：优先关闭下拉/右键菜单（捕获阶段，避免编辑器等吞掉按键）
        if (menu) {
          e.preventDefault();
          e.stopPropagation();
          this.closeMenus();
        }
        return;
      }
      if (!menu) return;
      // Chrome 风格键盘导航：↑↓ 选择、Enter 执行、←→ 切换顶级菜单
      const drops = [...menu.querySelectorAll<HTMLElement>(".menu-item-drop")];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (!drops.length) return;
        const idx = drops.findIndex((x) => x.classList.contains("focused"));
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next = idx < 0 ? (dir > 0 ? 0 : drops.length - 1) : (idx + dir + drops.length) % drops.length;
        drops.forEach((x) => x.classList.remove("focused"));
        drops[next].classList.add("focused");
        drops[next].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        const f = menu.querySelector<HTMLElement>(".menu-item-drop.focused");
        if (f) {
          e.preventDefault();
          e.stopPropagation();
          f.click();
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const open = document.querySelector<HTMLElement>(".menu-item.open");
        if (!open) return;
        const all = [...document.querySelectorAll<HTMLElement>("#menubar .menu-item")];
        const i = all.indexOf(open);
        const next = all[i + (e.key === "ArrowRight" ? 1 : -1)];
        if (next) next.click();
      }
    }, true);
    document.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest?.(".dropdown-menu")) return;
      // 顶级菜单项的开关逻辑交给 click（toggle），mousedown 不干预
      if ((e.target as HTMLElement).closest?.(".menu-item")) return;
      this.closeMenus();
    });
  }
}