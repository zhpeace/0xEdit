import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "./i18n";

const MIN_FONT = 11;
const MAX_FONT = 24;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface TermParams {
  host: string;
  port: number;
  username: string;
  password: string;
  keyPath?: string | null;
  passphrase?: string | null;
  initialDir?: string;
}

// 一个远程终端 Tab：xterm 渲染 + SSH PTY 数据流
export class RemoteTerm {
  readonly id: string;
  host: string;
  // 固定 tab 名：用户名@账户名称（可被用户"重命名会话"覆盖）
  title: string;
  // 远程 shell 发来的标题（如 root@hh6:~），仅用于悬停提示，不覆盖 tab 名
  remoteTitle = "";
  el: HTMLElement;
  private term: Terminal;
  private fit: FitAddon;
  private search: SearchAddon;
  private unlisteners: UnlistenFn[] = [];
  private disposed = false;
  private ro: ResizeObserver | null = null;
  private writeQ: string[] = [];
  private writing = false;
  private findBar: HTMLElement;
  private findInput!: HTMLInputElement;
  private findCount!: HTMLElement;
  onExit: ((reason: string) => void) | null = null;
  onTitle: ((title: string) => void) | null = null;

  constructor(host: string, username: string, accountName: string) {
    this.host = host;
    this.title = username ? `${username}@${accountName || host}` : accountName || host;
    this.id = `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mono = cssVar("--mono") || "Menlo";
    this.term = new Terminal({
      fontSize: 13,
      lineHeight: 1.25,
      fontFamily: `${mono}, Menlo, monospace`,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: this.resolveTheme(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.search = new SearchAddon();
    this.term.loadAddon(this.search);
    // macOS ⌘C/⌘V/⌘A 复制粘贴全选（无选区时 ⌘C 放行为中断信号）
    this.term.attachCustomKeyEventHandler((e) => this.onTermKey(e));
    // 远端标题同步（vim/tmux 等设置标题时）
    this.term.onTitleChange((title) => {
      if (this.onTitle) this.onTitle(title);
    });
    this.el = document.createElement("div");
    this.el.className = "term-host";
    this.term.open(this.el);
    this.findBar = document.createElement("div");
    this.findBar.className = "term-findbar hidden";
    this.findBar.append(...this.buildFindBar());
    this.el.prepend(this.findBar);
    // 点击终端区域即聚焦
    this.el.addEventListener("pointerdown", () => this.focus());
    // 右键粘贴（macOS 习惯）
    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void navigator.clipboard
        .readText()
        .then((txt) => {
          if (txt) this.term.paste(txt);
        })
        .catch(() => {});
    });
  }

  private resolveTheme() {
    return {
      background: cssVar("--bg") || "#1e1e1e",
      foreground: cssVar("--fg") || "#d4d4d4",
      cursor: cssVar("--accent") || "#2f81f7",
      selectionBackground: cssVar("--ed-sel") || "#264f78",
    };
  }

  // 跟随应用主题
  updateTheme() {
    this.term.options.theme = this.resolveTheme();
  }

  private onTermKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return true;
    const k = e.key.toLowerCase();
    if (k === "c") {
      if (this.term.hasSelection()) {
        void navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
        e.preventDefault();
        return false;
      }
      return true; // 无选区：交给终端（Ctrl+C 中断）
    }
    if (k === "v") {
      void navigator.clipboard
        .readText()
        .then((txt) => {
          if (txt) this.term.paste(txt);
        })
        .catch(() => {});
      e.preventDefault();
      return false;
    }
    if (k === "a") {
      this.term.selectAll();
      e.preventDefault();
      return false;
    }
    return true;
  }

  private buildFindBar(): HTMLElement[] {
    const input = document.createElement("input");
    input.className = "term-find-input";
    input.placeholder = t("查找…");
    input.addEventListener("input", () => this.doFind(input.value, true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.doFind(input.value, !e.shiftKey);
      } else if (e.key === "Escape") {
        this.hideFind();
      }
    });
    const count = document.createElement("span");
    count.className = "term-find-count";
    const prev = document.createElement("button");
    prev.textContent = "↑";
    prev.title = t("上一个");
    prev.addEventListener("click", () => this.doFind(input.value, false));
    const next = document.createElement("button");
    next.textContent = "↓";
    next.title = t("下一个");
    next.addEventListener("click", () => this.doFind(input.value, true));
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = t("关闭");
    close.addEventListener("click", () => this.hideFind());
    this.findInput = input;
    this.findCount = count;
    return [input, count, prev, next, close];
  }

  showFind() {
    this.findBar.classList.remove("hidden");
    this.findInput.focus();
    this.findInput.select();
  }

  hideFind() {
    this.findBar.classList.add("hidden");
    this.search.clearDecorations();
    this.findCount.textContent = "";
    this.term.focus();
  }

  private doFind(q: string, forward: boolean) {
    if (!q) {
      this.search.clearDecorations();
      this.findCount.textContent = "";
      return;
    }
    const opts = {
      decorations: {
        matchBackground: "#3d59a1",
        activeMatchBackground: "#5278d4",
        matchOverviewRuler: "#3d59a1",
        activeMatchColorOverviewRuler: "#5278d4",
      },
    };
    const found = forward ? this.search.findNext(q, opts) : this.search.findPrevious(q, opts);
    this.findCount.textContent = found ? "" : t("未找到");
  }

  zoomIn() {
    const size = this.term.options.fontSize ?? 13;
    if (size < MAX_FONT) {
      this.term.options.fontSize = size + 1;
      this.fitTerm();
    }
  }

  zoomOut() {
    const size = this.term.options.fontSize ?? 13;
    if (size > MIN_FONT) {
      this.term.options.fontSize = size - 1;
      this.fitTerm();
    }
  }

  async start(params: TermParams) {
    const unOut = await listen<string>("term-out", (e) => {
      const p = e.payload as unknown as { id: string; data: string };
      if (p && p.id === this.id && !this.disposed) this.queueWrite(p.data);
    });
    const unExit = await listen<string>("term-exit", (e) => {
      const p = e.payload as unknown as { id: string; reason: string };
      if (p && p.id === this.id && !this.disposed) {
        this.queueWrite(`\r\n\x1b[90m${t("[会话已结束: {r}]", { r: p.reason })}\x1b[0m\r\n`);
        this.disposed = true;
        this.onExit?.(p.reason);
      }
    });
    this.unlisteners.push(unOut, unExit);
    this.term.onData((d) => {
      if (!this.disposed) void invoke("write_shell", { id: this.id, data: d }).catch(() => {});
    });
    this.ro = new ResizeObserver(() => {
      this.fitTerm();
    });
    this.ro.observe(this.el);
    try {
      await invoke<string>("open_remote_shell", {
        key: this.id,
        host: params.host,
        port: params.port,
        username: params.username,
        password: params.password,
        keyPath: params.keyPath || null,
        passphrase: params.passphrase || null,
        initialDir: params.initialDir || null,
      });
      window.setTimeout(() => this.fitTerm(), 50);
      this.term.focus();
    } catch (e) {
      this.queueWrite(`\r\n\x1b[31m${t("打开终端失败: {e}", { e: String(e) })}\x1b[0m\r\n`);
    }
  }

  // 输出背压：批量合并 + 写完一批再写下一批，大输出不卡 UI
  private queueWrite(s: string) {
    this.writeQ.push(s);
    if (this.writeQ.length > 2000) this.writeQ.splice(0, this.writeQ.length - 2000);
    this.flush();
  }

  // 输出背压：批量合并 + 直接写入 xterm（xterm 内部自带队列）。
  // 注意：不能依赖 term.write 的回调——一旦某次回调丢失，writing 会永久卡死，
  // 导致后续所有输出（vi 全屏重绘等）被吞掉，界面冻结。
  // 另加强制 refresh 兜底：xterm 6.x 偶发渲染调度失效（数据已写入但画布不更新），
  // 写入后主动触发重绘。
  private flush() {
    if (this.writing || this.writeQ.length === 0) return;
    this.writing = true;
    try {
      while (this.writeQ.length) {
        const chunk = this.writeQ.splice(0, 100).join("");
        this.term.write(chunk);
      }
      try {
        this.term.refresh(0, this.term.rows - 1);
      } catch {
        /* refresh 失败不影响写入 */
      }
    } finally {
      this.writing = false;
    }
  }

  fitTerm() {
    try {
      this.fit.fit();
      const dims = this.fit.proposeDimensions();
      if (dims && dims.cols > 0 && dims.rows > 0) {
        void invoke("resize_shell", { id: this.id, cols: dims.cols, rows: dims.rows }).catch(() => {});
      }
    } catch {
      /* 容器未就绪时忽略 */
    }
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    this.disposed = true;
    void invoke("close_shell", { id: this.id }).catch(() => {});
    this.ro?.disconnect();
    for (const u of this.unlisteners) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unlisteners = [];
    this.writeQ = [];
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
    this.el.remove();
  }
}
