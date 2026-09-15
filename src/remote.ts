import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { t, onLangChange } from "./i18n";
import {
  isArchiveFile, archiveKindOf, buildArchiveTree, findArchiveChildren,
  ARCHIVE_BIG_BYTES, type ArchiveEntry, type ArchiveNode,
} from "./archive";
import { extFor, iconLabel } from "./fileicons";
import type { TermParams } from "./term";
import { sortEntries, loadTreeSort, createSortBar, fmtTime, kindLabel, type TreeSortState } from "./tree-sort";

export function newTransferId(): string {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function formatBytes(b: number): string {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + " GB";
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + " MB";
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(0) + " KB";
  return b + " B";
}

interface FtpEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified?: number;
}

interface FtpListResult {
  pwd: string;
  entries: FtpEntry[];
}

/** 一个已连接服务器会话的全部状态（多会话并行，MobaXterm 式） */
interface SessionState {
  siteId: string;
  connId: string;
  proto: "ftp" | "sftp" | "ftps";
  path: string;
  expanded: Set<string>;
  loading: Set<string>;
  selectedPath: string | null;
  selectedPaths: Set<string>;
  selectAnchor: string | null;
  ctxIsDir: boolean;
  selNode: HTMLElement | null;
  arcView: { tmp: string; kind: string; arcName: string; remotePath: string; dir: string } | null;
  arcTree: ArchiveNode[];
  arcTreeTmp: string;
  curConn: TermParams | null;
  el: HTMLElement | null; // 预留（目录树为面板级单例，会话无独立容器）
}

const EMPTY_SET = new Set<string>();
const EMPTY_ARC: ArchiveNode[] = [];

export interface RemoteSite {
  id: string;
  name: string;
  proto: "ftp" | "sftp" | "ftps";
  host: string;
  port: number;
  username: string;
  password: string;
  savePassword: boolean;
  authMethod: "auto" | "password" | "keyboard" | "publickey";
  keyPath: string;
  passphrase: string;
  remoteDir: string;
  localDir: string;
  passive: boolean;
  xfer: "auto" | "ascii" | "binary";
  timeout: number;
  retry: number;
  group: string;
}

const REMOTE_STORE_KEY = "uec.remotes";

function genId(): string {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function newAccount(): RemoteSite {
  return {
    id: genId(),
    name: t("新账户"),
    proto: "sftp",
    host: "",
    port: 22,
    username: "",
    password: "",
    savePassword: true,
    authMethod: "auto",
    keyPath: "",
    passphrase: "",
    remoteDir: "/",
    localDir: "",
    passive: true,
    xfer: "auto",
    timeout: 30,
    retry: 3,
    group: "",
  };
}

function normalizeSite(s: any): RemoteSite {
  const d = newAccount();
  return {
    id: s.id || genId(),
    name: s.name || d.name,
    proto: s.proto || d.proto,
    host: s.host || "",
    port: s.port || (s.proto === "sftp" ? 22 : 21),
    username: s.username || "",
    password: s.password || "",
    savePassword: s.savePassword !== false,
    authMethod: s.authMethod || "auto",
    keyPath: s.keyPath || "",
    passphrase: s.passphrase || "",
    remoteDir: s.remoteDir || "/",
    localDir: s.localDir || "",
    passive: s.passive !== false,
    xfer: s.xfer || "auto",
    timeout: s.timeout || 30,
    retry: s.retry || 3,
    group: s.group || "",
  };
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function join(p: string, name: string): string {
  if (p === "/") return "/" + name;
  return p.replace(/\/+$/, "") + "/" + name;
}

function baseName(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

function defaultPort(proto: string): number {
  return proto === "sftp" ? 22 : 21;
}

export class RemoteBrowser {
  private el: HTMLElement;
  private transferLastPaint = 0;
  // 剪贴板式复制：{ src, name }，粘贴到当前浏览目录（同协议）
  private clipboard: { srcs: string[]; name: string } | null = null;
  private transfers = new Map<string, {
    kind: string; name: string; bar: HTMLElement; fill: HTMLElement; meta: HTMLElement;
    done: number; total: number; err: string | null;
  }>();
  // ---- 多会话（MobaXterm 式）：每台已连接服务器一个 SessionState ----
  private sessions = new Map<string, SessionState>();
  private activeSiteId: string | null = null;
  private ctxGroup: string | null = null;
  private listStatusTimer = 0;
  private sites: RemoteSite[] = [];
  private selSiteId: string | null = null;
  private onOpenRemote: (tmp: string, proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string) => void;
  private onOpenArchive: (
    tmp: string, kind: string, entry: string, archiveName: string,
    proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string,
  ) => void;
  private getActivePath: () => string;
  private archiveCache = new Map<string, string>(); // remotePath -> 已下载归档 tmp
  private onOpenTerminal?: (params: TermParams, initialDir?: string, siteId?: string) => void;
  private onCloseTerms?: (siteId: string) => void;
  private showHidden = false;
  private sort: TreeSortState = loadTreeSort();
  private filterText = "";
  // 右键临时目标（动作紧接着右键执行，不跨会话）
  private ctxArcNode: HTMLElement | null = null;
  private ctxNode: HTMLElement | null = null;

  private get cur(): SessionState | null {
    return this.activeSiteId ? this.sessions.get(this.activeSiteId) ?? null : null;
  }
  private get id(): string { return this.cur?.connId ?? ""; }
  private set id(v: string) { if (this.cur) this.cur.connId = v; }
  private get proto(): "ftp" | "sftp" | "ftps" { return this.cur?.proto ?? "ftp"; }
  private set proto(v: "ftp" | "sftp" | "ftps") { if (this.cur) this.cur.proto = v; }
  private get path(): string { return this.cur?.path ?? "/"; }
  private set path(v: string) { if (this.cur) this.cur.path = v; }
  private get expanded(): Set<string> { return this.cur?.expanded ?? EMPTY_SET; }
  private get loading(): Set<string> { return this.cur?.loading ?? EMPTY_SET; }
  private get selectedPath(): string | null { return this.cur?.selectedPath ?? null; }
  private set selectedPath(v: string | null) { if (this.cur) this.cur.selectedPath = v; }
  private get ctxIsDir(): boolean { return this.cur?.ctxIsDir ?? false; }
  private set ctxIsDir(v: boolean) { if (this.cur) this.cur.ctxIsDir = v; }
  private get selectedNode(): HTMLElement | null { return this.cur?.selNode ?? null; }
  private set selectedNode(v: HTMLElement | null) { if (this.cur) this.cur.selNode = v; }
  private get arcView(): { tmp: string; kind: string; arcName: string; remotePath: string; dir: string } | null { return this.cur?.arcView ?? null; }
  private set arcView(v: { tmp: string; kind: string; arcName: string; remotePath: string; dir: string } | null) { if (this.cur) this.cur.arcView = v; }
  private get arcTree(): ArchiveNode[] { return this.cur?.arcTree ?? EMPTY_ARC; }
  private set arcTree(v: ArchiveNode[]) { if (this.cur) this.cur.arcTree = v; }
  private get arcTreeTmp(): string { return this.cur?.arcTreeTmp ?? ""; }
  private set arcTreeTmp(v: string) { if (this.cur) this.cur.arcTreeTmp = v; }
  private get curConn(): TermParams | null { return this.cur?.curConn ?? null; }
  private set curConn(v: TermParams | null) { if (this.cur) this.cur.curConn = v; }
  private get connectedSiteId(): string | null { return this.activeSiteId; }
  private set connectedSiteId(v: string | null) { this.activeSiteId = v; }

  constructor(
    el: HTMLElement,
    onOpenRemote: (tmp: string, proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string) => void,
    getActivePath: () => string,
    onOpenArchive: (
      tmp: string, kind: string, entry: string, archiveName: string,
      proto: "ftp" | "sftp" | "ftps", id: string, remotePath: string,
    ) => void,
    showHidden = false,
    onOpenTerminal?: (params: TermParams, initialDir?: string, siteId?: string) => void,
    onCloseTerms?: (siteId: string) => void,
  ) {
    this.el = el;
    this.onOpenRemote = onOpenRemote;
    this.getActivePath = getActivePath;
    this.onOpenArchive = onOpenArchive;
    this.showHidden = showHidden;
    this.onOpenTerminal = onOpenTerminal;
    this.onCloseTerms = onCloseTerms;
    this.sort = loadTreeSort();
    el.innerHTML = `
      <div id="rs-panel-tabs" class="rs-panel-tabs">
        <button id="rs-panel-list" class="rs-panel-tab active">${t("列表")}</button>
        <button id="rs-panel-tree" class="rs-panel-tab">${t("目录树")}</button>
      </div>
      <div id="rs-list-view">
        <div class="rs-list-head">
          <span class="rs-list-title" id="rs-list-title">${t("服务器")}</span>
          <input id="rs-filter" class="fs-input" placeholder="${t("搜索服务器…")}" spellcheck="false"/>
          <button class="search-btn" id="rs-new">+ ${t("新建连接")}</button>
        </div>
        <div id="rs-list-status" class="rs-list-status hidden"></div>
        <div id="rs-items"></div>
        <div id="rs-empty" class="rs-empty hidden">${t("暂无服务器，点「+ 新建连接」添加")}</div>
      </div>
      <div id="rs-conn-view" class="hidden">
        <div class="rs-connbar" id="rs-connbar">
          <span class="rs-conn-info" id="rs-conn-info"></span>
          <button class="search-btn" id="rs-term" title="${t("基于当前连接打开远程终端")}">${t("终端")}</button>
          <button class="search-btn" id="rs-disconnect" title="${t("断开连接")}">${t("断开")}</button>
        </div>
        <div class="ft-status" id="ftp-status"></div>
        <div class="ft-path" id="ftp-path"></div>
        <div id="ftp-tree-wrap">
          <div id="ftp-sortbar"></div>
          <div id="ftp-tree" class="ft-dir"></div>
        </div>
      </div>
      <div id="ftp-ctx" class="ctx-menu hidden">
        <div class="ctx-item hidden" data-arc="1" data-act="arc-open">${t("打开")}</div>
        <div class="ctx-item hidden" data-arc="1" data-act="arc-copypath">${t("复制路径")}</div>
        <div class="ctx-item hidden" data-arc="1" data-act="arc-refresh">${t("刷新归档")}</div>
        <div class="ctx-item hidden" data-arc="1" data-act="arc-extract">${t("提取到本地…")}</div>
        <div class="ctx-sep hidden" data-arc="1"></div>
        <div class="ctx-item" data-act="newfile">${t("新建文件")}</div>
        <div class="ctx-item" data-act="newdir">${t("新建文件夹")}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-act="open">${t("打开")}</div>
        <div class="ctx-item" data-act="openwith">${t("用默认应用打开")}</div>
        <div class="ctx-item" data-act="extract">${t("解压文件…")}</div>
        <div class="ctx-item" data-act="extract-here">${t("解压到下载目录")}</div>
        <div class="ctx-item" data-act="extract-named">${t("解压到 ")}<span data-name-label></span>\\</div>
        <div class="ctx-item" data-act="saveas">${t("下载到本地…")}</div>
        <div class="ctx-item" data-act="term-here">${t("在终端中打开")}</div>
        <div class="ctx-item" data-act="rename">${t("重命名")}</div>
        <div class="ctx-item" data-act="copy">${t("复制")}</div>
        <div class="ctx-item" data-act="paste">${t("粘贴")}</div>
        <div class="ctx-item" data-act="copypath">${t("复制路径")}</div>
        <div class="ctx-item ctx-danger" data-act="del">${t("删除")}</div>
      </div>
      <div id="ftp-ctx-panel" class="ctx-menu hidden">
        <div class="ctx-item" data-act="refresh">${t("刷新")}</div>
        <div class="ctx-item" data-act="up">${t("上级")}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-act="newfile">${t("新建文件")}</div>
        <div class="ctx-item" data-act="newdir">${t("新建文件夹")}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-act="upload-files">${t("上传文件…")}</div>
        <div class="ctx-item" data-act="upload-cur">${t("上传当前文件")}</div>
        <div class="ctx-item" data-act="paste">${t("粘贴")}</div>
        <div class="ctx-item" data-act="term">${t("在终端中打开")}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item ctx-danger" data-act="disconnect">${t("断开连接")}</div>
      </div>
      <div id="rs-group-ctx" class="ctx-menu hidden">
        <div class="ctx-item" data-act="new-subgroup">${t("新建子分组…")}</div>
        <div class="ctx-item" data-act="rename-group">${t("重命名分组")}</div>
        <div class="ctx-item ctx-danger" data-act="del-group">${t("删除分组")}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-act="collapse-all">${t("折叠全部")}</div>
        <div class="ctx-item" data-act="expand-all">${t("展开全部")}</div>
      </div>
      <div id="rs-list-ctx" class="ctx-menu hidden">
        <div class="ctx-item" data-act="new-group">${t("新建分组…")}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-act="new-site">${t("新建连接")}</div>
      </div>`;

    el.querySelector("#rs-new")!.addEventListener("click", () => this.openAccountManager(true));
    el.querySelector<HTMLInputElement>("#rs-filter")!.addEventListener("input", () => this.renderSites());
    // 面板级 tab：列表 / 目录树（MobaXterm 式单视图）
    el.querySelector("#rs-panel-list")!.addEventListener("click", () => this.setPanelTab("list"));
    el.querySelector("#rs-panel-tree")!.addEventListener("click", () => this.setPanelTab("tree"));
    el.querySelector("#rs-disconnect")!.addEventListener("click", () => void this.disconnect());
    el.querySelector("#rs-term")!.addEventListener("click", () => this.openTerminalHere());
    const gctx = el.querySelector<HTMLElement>("#rs-group-ctx")!;
    gctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        gctx.classList.add("hidden");
        void this.groupAction(item.dataset.act!);
      });
    });
    el.addEventListener("click", (e) => {
      if (!gctx.contains(e.target as Node)) gctx.classList.add("hidden");
    });
    const lctx = el.querySelector<HTMLElement>("#rs-list-ctx")!;
    lctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        lctx.classList.add("hidden");
        const act = item.dataset.act!;
        if (act === "new-group") void this.ctxNewGroup();
        else if (act === "new-site") this.openAccountManager(true);
      });
    });
    const lv = el.querySelector<HTMLElement>("#rs-list-view")!;
    lv.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".rs-item, .rs-group")) return;
      if (e.button === 0 && (e.ctrlKey || e.detail > 0)) { e.preventDefault(); return; }
      e.preventDefault();
      const lActs: Record<string, string> = { "new-group": t("新建分组…"), "new-site": t("新建连接") };
      lctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((it) => {
        const a = it.dataset.act;
        if (a && lActs[a]) it.textContent = lActs[a];
      });
      lctx.style.left = `${e.clientX}px`;
      lctx.style.top = `${e.clientY}px`;
      lctx.classList.remove("hidden");
    });
    el.addEventListener("click", (e) => {
      if (!lctx.contains(e.target as Node)) lctx.classList.add("hidden");
    });
    const items = el.querySelector<HTMLElement>("#rs-items")!;
    items.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".rs-item");
      if (!row) return;
      const id = row.dataset.id!;
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-op]");
      if (btn) {
        const op = btn.dataset.op!;
        if (op === "connect") {
          // 已连接：直接切目录树到它；未连接：建立会话
          if (this.connectedSiteId === id) {
            this.activateSession(id);
            this.setPanelTab("tree");
          } else {
            const s = this.sites.find((x) => x.id === id);
            if (s) void this.connectSite(s);
          }
          return;
        }
        if (op === "copy") {
          this.duplicateSite(id);
          return;
        }
        if (op === "edit") {
          this.openAccountManager(false, id);
          return;
        }
        if (op === "del") {
          void this.deleteSite(id);
          return;
        }
        return;
      }
      this.selSiteId = id;
      this.renderSites();
    });
    items.addEventListener("dblclick", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".rs-item");
      if (!row) return;
      const id = row.dataset.id!;
      const s = this.sites.find((x) => x.id === id);
      if (!s) return;
      if (this.connectedSiteId === id) {
        this.activateSession(id);
        this.setPanelTab("tree");
        return;
      }
      void this.connectSite(s);
    });
    const pctx = el.querySelector<HTMLElement>("#ftp-ctx-panel")!;
    pctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        pctx.classList.add("hidden");
        const act = item.dataset.act!;
        if (act === "refresh") void this.refresh();
        else if (act === "up") this.cmdUp();
        else if (act === "newfile") void this.ctxNewFile();
        else if (act === "newdir") void this.ctxNewDir();
        else if (act === "upload-files") void this.uploadFiles();
        else if (act === "upload-cur") void this.upload();
        else if (act === "paste") void this.pasteClipboard();
        else if (act === "term") this.openTerminalHere();
        else if (act === "disconnect") void this.disconnect();
      });
    });
    document.addEventListener("click", (e) => {
      if (!pctx.contains(e.target as Node)) pctx.classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") pctx.classList.add("hidden");
    });
    this.loadSites();
    this.renderSites();
    const ctx = this.el.querySelector<HTMLElement>("#ftp-ctx")!;
    const treeEl = el.querySelector<HTMLElement>("#ftp-tree")!;
    treeEl.addEventListener("contextmenu", (e: MouseEvent) => {
      // macOS 上 Ctrl+单击 会被系统当作右键触发 contextmenu（左键 + ctrlKey），
      // 但 Ctrl+单击 的语义是加选，不应弹右键菜单。
      // 拦截条件：左键触发（button=0）且带 Ctrl（macOS Ctrl+单击）或非常规键盘触发（detail>0，即物理点击）。
      // 真右键（button=2）与键盘 Shift+F10（button=0/ctrlKey=false/detail=0）不受影响。
      if (e.button === 0 && (e.ctrlKey || e.detail > 0)) {
        e.preventDefault();
        return;
      }
      const node = (e.target as HTMLElement).closest<HTMLElement>("[data-name], .ft-arc");
      if (!node) {
        e.preventDefault();
        this.selectedPath = null;
        this.ctxNode = null;
        this.clearRemoteMulti();
        const pPaste = pctx.querySelector('[data-act="paste"]') as HTMLElement;
        if (pPaste) this.applyPasteState(pPaste);
        pctx.style.left = `${e.clientX}px`;
        pctx.style.top = `${e.clientY}px`;
        pctx.classList.remove("hidden");
        return;
      }
      e.preventDefault();
      const isArc = node.classList.contains("ft-arc");
      this.ctxIsDir = node.classList.contains("ft-dir");
      // 归档虚拟节点：归档专用菜单
      if (isArc) {
        this.ctxArcNode = node;
        this.selectedPath = null;
        ctx.querySelectorAll<HTMLElement>("[data-act]").forEach((it) => {
          const arc = it.dataset.arc === "1";
          it.classList.toggle("hidden", !arc);
        });
        ctx.style.left = `${e.clientX}px`;
        ctx.style.top = `${e.clientY}px`;
        ctx.classList.remove("hidden");
        return;
      }
      this.ctxArcNode = null;
      this.ctxNode = node;
      this.selectedPath = node.dataset.path || node.dataset.name!;
      // 右键多选语义：右键节点已在多选中则保持多选，否则单选该节点（集合内为完整路径）
      const nodeKey = this.remotePathOf(node);
      if (!this.cur || !this.cur.selectedPaths.has(nodeKey) || this.cur.selectedPaths.size <= 1) {
        this.cur?.selectedPaths.clear();
        this.cur?.selectedPaths.add(nodeKey);
        this.cur && (this.cur.selectAnchor = nodeKey);
        this.selectedNode = node;
        this.syncRemoteSelected();
      }
      (ctx.querySelector('[data-act="saveas"]') as HTMLElement).style.display = "";
      (ctx.querySelector('[data-act="open"]') as HTMLElement).style.display = this.ctxIsDir ? "none" : "";
      (ctx.querySelector('[data-act="openwith"]') as HTMLElement).style.display = this.ctxIsDir ? "none" : "";
      (ctx.querySelector('[data-act="term-here"]') as HTMLElement).style.display = this.ctxIsDir ? "" : "none";
      // 归档解压/测试组仅对归档文件生效（WinRAR 风格）
      const isArcFile = isArchiveFile(node.dataset.name!);
      for (const a of ["extract", "extract-here", "extract-named"]) {
        (ctx.querySelector(`[data-act="${a}"]`) as HTMLElement).style.display = isArcFile ? "" : "none";
      }
      if (isArcFile) {
        const base = (node.dataset.name!).replace(/(\.tar\.gz|\.tar\.bz2|\.tar\.xz|\.tar\.zst|\.tgz|\.tbz2|\.txz|\.tzst|\.zipx|\.zip|\.jar|\.war|\.ear|\.apk|\.aar|\.rar|\.7z|\.iso|\.cab|\.cpio|\.deb|\.rpm|\.zst|\.lz4|\.tar)$/i, "") || node.dataset.name!;
        (ctx.querySelector('[data-name-label]') as HTMLElement).textContent = base;
      }
      ctx.querySelectorAll<HTMLElement>("[data-act]").forEach((it) => {
        const arc = it.dataset.arc === "1";
        it.classList.toggle("hidden", arc);
      });
      // 多选时：单节点操作置灰，批量操作（复制/粘贴/删除/下载）保持可用
      const multi = (this.cur?.selectedPaths.size ?? 0) > 1;
      for (const a of ["open", "openwith", "rename", "copypath", "term-here", "extract", "extract-here", "extract-named"]) {
        const it = ctx.querySelector(`[data-act="${a}"]`) as HTMLElement | null;
        if (it) it.classList.toggle("ctx-disabled", multi);
      }
      const pasteIt = ctx.querySelector('[data-act="paste"]') as HTMLElement;
      if (pasteIt) this.applyPasteState(pasteIt);
      ctx.style.left = `${e.clientX}px`;
      ctx.style.top = `${e.clientY}px`;
      ctx.classList.remove("hidden");
    });
    ctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        ctx.classList.add("hidden");
        const act = item.dataset.act!;
        if (act === "newfile") { this.ctxNewFile(); return; }
        if (act === "newdir") { this.ctxNewDir(); return; }
        if (act === "paste") { void this.pasteClipboard(); return; }
        if (act.startsWith("arc-")) {
          void this.arcCtxAction(act, this.ctxArcNode);
          return;
        }
        if (!this.selectedPath) return;
        const paths = this.effectiveRemotePaths();
        if (!paths.length) return;
        if (["open", "openwith", "rename", "copypath", "term-here", "extract", "extract-here", "extract-named"].includes(act) && paths.length > 1) return;
        if (act === "open") {
          // 归档文件进入视图（与双击一致）；普通文件下载打开
          const node = this.ctxNode;
          if (node && isArchiveFile(node.dataset.name!)) void this.enterRemoteArchiveRoot(node);
          else this.download(this.selectedPath);
        }
        else if (act === "openwith") void this.openWithDefault(this.selectedPath);
        else if (act === "saveas") {
          // 多选：按右键节点类型逐个处理（目录递归下载/文件另存）；FTP 传裸名
          for (const p of paths) {
            const arg = this.isSftp() ? p : (p.split("/").filter(Boolean).pop() || p);
            if (this.ctxIsDir) void this.downloadDir(arg);
            else this.saveAs(arg);
          }
        }
        else if (act === "term-here") this.openTerminalHere(this.selectedPath);
        else if (act === "extract" || act === "extract-here" || act === "extract-named") void this.extractRemoteArchive(this.selectedPath, act);
        else if (act === "rename") this.doRename();
        else if (act === "copy") void this.setClipboardPaths(paths);
        else if (act === "copypath") void this.copyPath(this.selectedPath);
        else if (act === "del") this.delPaths(paths);
      });
    });
    document.addEventListener("click", (e) => {
      if (!ctx.contains(e.target as Node)) ctx.classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") ctx.classList.add("hidden");
    });
    treeEl.addEventListener("click", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>("[data-name]");
      if (!node) return;
      const isArrow = (e.target as HTMLElement).classList.contains("ft-arrow");
      const name = node.dataset.name!;
      // Finder：单击任意处（含箭头）选中；仅箭头触发展开动作；⌘/Ctrl+单击 加选，Shift+单击 范围选
      // 加选不弹右键菜单：即使系统已触发 contextmenu，也在同一次交互的 click 阶段立即关闭
      if (e.metaKey || e.ctrlKey) {
        const m = this.el.querySelector("#ftp-ctx");
        if (m) m.classList.add("hidden");
      }
      if (e.shiftKey) this.selectRemoteRange(node);
      else this.selectNode(node, e.metaKey || e.ctrlKey);
      if (node.dataset.actions === "up") return;
      const isDir = node.dataset.dir === "1";
      if (isDir) {
        if (isArrow) {
          if (this.isSftp()) void this.toggleExpand(node);
          else void this.toggleFtpExpand(node);
        }
        return;
      }
      if (isArchiveFile(name)) {
        // 归档文件：箭头展开内部结构
        if (isArrow) void this.archiveExpand(node);
        return;
      }
      if (isBinaryName(name)) {
        // 其余二进制文件不自动下载打开，提示走右键下载
        if (isArrow) this.status(t("归档/二进制文件：右键『下载到本地…』打开"));
        return;
      }
      // 普通文件：仅选中（双击打开）
    });
    treeEl.addEventListener("dblclick", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>("[data-name]");
      if (!node) return;
      const name = node.dataset.name!;
      if (node.dataset.actions === "up") {
        this.cmdUp();
        return;
      }
      const isDir = node.dataset.dir === "1";
      if (isDir) {
        // 双击目录 = 进入（Finder）
        if (this.isSftp()) {
          const prev = this.path;
          this.expanded.clear();
          // 用渲染时算好的完整路径（展开的子目录场景），避免从当前 path 重新拼接出错
          this.path = node.dataset.path || join(this.path, name);
          void (async () => {
            if (!(await this.refresh())) this.path = prev; // 进入失败回滚
          })();
        } else {
          // FTP 子层节点用相对路径链（展开的子目录），避免只取末级名
          this.cmdInto(node.dataset.path || name);
        }
        return;
      }
      if (isArchiveFile(name)) {
        // 双击归档文件 = 进入归档根视图
        void this.enterRemoteArchiveRoot(node);
        return;
      }
      if (isBinaryName(name)) return;
      this.download(node.dataset.path || node.dataset.name!);
    });
    this.initTransferBar();
    onLangChange(() => this.localizePanel());
    // 远程树快捷键：⌘C/⌘V（mac）与 Ctrl+C/V（Win/Linux）复制/粘贴远程文件
    document.addEventListener("keydown", (e) => this.onGlobalKey(e));
    this.ensureRemoteSortBar();
  }

  private localizePanel() {
    const setTxt = (sel: string, key: string) => {
      const e = this.el.querySelector<HTMLElement>(sel);
      if (e) e.textContent = t(key);
    };
    setTxt("#rs-new", "新建连接");
    setTxt("#rs-panel-list", "列表");
    setTxt("#rs-panel-tree", "目录树");
    setTxt("#rs-term", "终端");
    this.el.querySelector<HTMLElement>("#rs-term")!.title = t("基于当前连接打开远程终端");
    setTxt("#rs-disconnect", "断开");
    this.el.querySelector<HTMLElement>("#rs-disconnect")!.title = t("断开连接");
    const title = this.el.querySelector<HTMLElement>("#rs-list-title");
    if (title) title.textContent = t("服务器");
    const filt = this.el.querySelector<HTMLInputElement>("#rs-filter");
    if (filt) filt.placeholder = t("搜索服务器…");
    const empty = this.el.querySelector<HTMLElement>("#rs-empty");
    if (empty) empty.textContent = t("暂无服务器，点「+ 新建连接」添加");
    // 面板级右键菜单
    const panelItems: Array<[string, string]> = [
      ["#ftp-ctx-panel [data-act='refresh']", "刷新"],
      ["#ftp-ctx-panel [data-act='up']", "上级"],
      ["#ftp-ctx-panel [data-act='newfile']", "新建文件"],
      ["#ftp-ctx-panel [data-act='newdir']", "新建文件夹"],
      ["#ftp-ctx-panel [data-act='upload-files']", "上传文件…"],
      ["#ftp-ctx-panel [data-act='upload-cur']", "上传当前文件"],
      ["#ftp-ctx-panel [data-act='paste']", "粘贴"],
      ["#ftp-ctx-panel [data-act='term']", "在终端中打开"],
      ["#ftp-ctx-panel [data-act='disconnect']", "断开连接"],
    ];
    for (const [sel, key] of panelItems) {
      const e = this.el.querySelector<HTMLElement>(sel);
      if (e) e.textContent = t(key);
    }
    // 文件/文件夹右键菜单
    const ctxOpen = this.el.querySelector('#ftp-ctx [data-act="open"]');
    if (ctxOpen) ctxOpen.textContent = t("打开");
    const ctxNewFile = this.el.querySelector('#ftp-ctx [data-act="newfile"]');
    if (ctxNewFile) ctxNewFile.textContent = t("新建文件");
    const ctxNewDir = this.el.querySelector('#ftp-ctx [data-act="newdir"]');
    if (ctxNewDir) ctxNewDir.textContent = t("新建文件夹");
    const ctxSave = this.el.querySelector('#ftp-ctx [data-act="saveas"]');
    if (ctxSave) ctxSave.textContent = t("下载到本地…");
    const ctxRen = this.el.querySelector('#ftp-ctx [data-act="rename"]');
    if (ctxRen) ctxRen.textContent = t("重命名");
    const ctxCopy = this.el.querySelector('#ftp-ctx [data-act="copypath"]');
    if (ctxCopy) ctxCopy.textContent = t("复制路径");
    const ctxCopyFile = this.el.querySelector('#ftp-ctx [data-act="copy"]');
    if (ctxCopyFile) ctxCopyFile.textContent = t("复制");
    const ctxPasteFile = this.el.querySelector('#ftp-ctx [data-act="paste"]');
    if (ctxPasteFile) ctxPasteFile.textContent = t("粘贴");
    const ctxDel = this.el.querySelector('#ftp-ctx [data-act="del"]');
    if (ctxDel) ctxDel.textContent = t("删除");
    // 列表行内按钮（连接/编辑/删除提示）语言跟随
    this.renderSites();
    this.ensureRemoteSortBar();
  }

  // 重建远程排序栏（Finder 列头式，字段/方向切换后刷新）
  private initTransferBar() {
    if (document.getElementById("transfer-bar")) return;
    const bar = document.createElement("div");
    bar.id = "transfer-bar";
    bar.className = "transfer-bar";
    document.body.appendChild(bar);
    void listen<{
      task_id: string; kind: string; name: string; done: number; total: number;
      state: string; error?: string | null;
    }>("uec-transfer", (ev) => this.onTransfer(ev.payload)).catch(() => {});
  }

  private ensureTransferItem(taskId: string, kind: string, name: string) {
    let it = this.transfers.get(taskId);
    if (!it) {
      const bar = document.createElement("div");
      bar.className = "tr-item" + (kind === "dir" ? " tr-dir" : "");
      const nm = document.createElement("div");
      nm.className = "tr-name";
      nm.textContent = name;
      const track = document.createElement("div");
      track.className = "tr-track";
      const fill = document.createElement("div");
      fill.className = "tr-fill";
      track.appendChild(fill);
      const meta = document.createElement("div");
      meta.className = "tr-meta";
      meta.textContent = "0%";
      const close = document.createElement("button");
      close.className = "tr-close";
      close.textContent = "×";
      close.title = t("关闭");
      close.onclick = () => {
        bar.remove();
        this.transfers.delete(taskId);
      };
      bar.append(nm, track, meta, close);
      document.getElementById("transfer-bar")!.appendChild(bar);
      it = { kind, name, bar, fill, meta, done: 0, total: 0, err: null };
      this.transfers.set(taskId, it);
    }
    return it;
  }

  private onTransfer(ev: {
    task_id: string; kind: string; name: string; done: number; total: number;
    state: string; error?: string | null;
  }) {
    const it = this.ensureTransferItem(ev.task_id, ev.kind, ev.name);
    it.done = ev.done;
    it.total = ev.total;
    if (ev.state === "done") {
      it.bar.classList.add("tr-done");
      it.fill.style.width = "100%";
      it.meta.textContent = t("已完成") + " · " + formatBytes(ev.total);
      return;
    }
    if (ev.state === "error") {
      it.err = ev.error || "";
      it.bar.classList.add("tr-err");
      it.meta.textContent = t("失败");
      return;
    }
    const now = Date.now();
    if (now - this.transferLastPaint < 80) return;
    this.transferLastPaint = now;
    const pct = it.total > 0 ? Math.min(99, Math.round((it.done / it.total) * 100)) : 0;
    it.fill.style.width = pct + "%";
    it.meta.textContent = it.total > 0 ? pct + "%" : t("传输中…");
  }
  private ensureRemoteSortBar() {
    const host = this.q<HTMLElement>("#ftp-sortbar");
    if (!host) return;
    host.innerHTML = "";
    const bar = createSortBar(this.sort, (next) => {
      this.sort = next;
      this.ensureRemoteSortBar();
      void this.refresh();
    });
    const filter = document.createElement("input");
    filter.className = "ft-filter";
    filter.type = "text";
    filter.placeholder = t("搜索当前目录…");
    filter.value = this.filterText;
    filter.title = t("按名称过滤当前目录，ESC 清空");
    filter.addEventListener("input", () => {
      this.filterText = filter.value;
      void this.refresh();
    });
    filter.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (this.filterText) {
        this.filterText = "";
        filter.value = "";
        void this.refresh();
      }
      filter.blur();
    });
    bar.appendChild(filter);
    host.appendChild(bar);
  }

  // 目录树为面板级单例：在当前面板内查找元素
  private q<T extends HTMLElement>(sel: string): T | null {
    return this.el.querySelector<T>(sel);
  }

  private status(msg: string) {
    const el = this.q<HTMLElement>("#ftp-status");
    if (el) el.textContent = msg;
  }

  private isSftp() {
    return this.proto === "sftp";
  }

  private loadSites() {
    try {
      const raw = localStorage.getItem(REMOTE_STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      this.sites = Array.isArray(arr) ? arr.map((s: any) => normalizeSite(s)) : [];
    } catch {
      this.sites = [];
    }
  }

  private saveSites() {
    try {
      localStorage.setItem(REMOTE_STORE_KEY, JSON.stringify(this.sites));
    } catch {
      /* ignore */
    }
  }

  // 分组折叠状态（localStorage 记忆）
  private collapsedGroups(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem("uec.remote.groups.collapsed") || "[]"));
    } catch { return new Set(); }
  }

  private toggleGroup(group: string) {
    const cur = this.collapsedGroups();
    if (cur.has(group)) cur.delete(group); else cur.add(group);
    localStorage.setItem("uec.remote.groups.collapsed", JSON.stringify([...cur]));
    this.renderSites();
  }

  private renderSites() {
    const list = this.el.querySelector<HTMLElement>("#rs-items");
    if (!list) return;
    const q = (this.el.querySelector<HTMLInputElement>("#rs-filter")?.value || "").toLowerCase();
    const vis = this.sites.filter(
      (s) => !q || `${s.name} ${s.host} ${s.username} ${s.group}`.toLowerCase().includes(q),
    );
    list.innerHTML = "";
    this.el.querySelector<HTMLElement>("#rs-empty")!.classList.toggle("hidden", vis.length > 0);
    // secureCRT 风格文件夹树：group 按 "/" 分层（"生产/华东" = 二级），文件夹在前、服务器在后，同层按名排序
    interface GNode { name: string; path: string; children: Map<string, GNode>; sites: RemoteSite[]; }
    const root: GNode = { name: "", path: "", children: new Map(), sites: [] };
    for (const sv of vis) {
      const segs = sv.group.split("/").map((x) => x.trim()).filter(Boolean);
      let cur = root;
      let acc = "";
      for (const seg of segs) {
        acc = acc ? acc + "/" + seg : seg;
        if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: acc, children: new Map(), sites: [] });
        cur = cur.children.get(seg)!;
      }
      cur.sites.push(sv);
    }
    // 合并独立分组清单（空分组预建）
    for (const g of this.groupList()) {
      const segs = g.split("/").map((x) => x.trim()).filter(Boolean);
      let cur = root;
      let acc = "";
      for (const seg of segs) {
        acc = acc ? acc + "/" + seg : seg;
        if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: acc, children: new Map(), sites: [] });
        cur = cur.children.get(seg)!;
      }
    }
    const sortN = (a: GNode, b: GNode) => a.name.localeCompare(b.name, "zh-Hans-CN");
    const sortS = (a: RemoteSite, b: RemoteSite) => a.name.localeCompare(b.name, "zh-Hans-CN");
    const collapsed = this.collapsedGroups();
    const subCount = (n: GNode): number => {
      let c = n.sites.length;
      for (const ch of n.children.values()) c += subCount(ch);
      return c;
    };
    const row = (sv: RemoteSite, depth: number) => {
      const rowEl = document.createElement("div");
      const isConn = this.sessions.has(sv.id);
      const isActive = sv.id === this.connectedSiteId;
      rowEl.className = "rs-item"
        + (isConn ? " rs-connected" : "")
        + (isActive ? " rs-active" : "");
      rowEl.dataset.id = sv.id;
      rowEl.dataset.group = sv.group;
      const ico = sv.proto === "ftp"
        ? `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="#f0b429"/></svg>`
        : sv.proto === "ftps"
          ? `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" fill="#7db4ff"/></svg>`
          : `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" fill="#7db4ff"/></svg>`;
      rowEl.innerHTML = `
        <span class="rs-item-ico">${ico}</span>
        <span class="rs-item-main">
          <span class="rs-item-name">${escapeHtml(sv.name)}${isConn ? `<span class="rs-item-dot${isActive ? " active" : ""}" title="${isActive ? t("当前会话") : t("已连接")}">●</span>` : ""}</span>
          <span class="rs-item-sub">${sv.proto.toUpperCase()} · ${escapeHtml(sv.host)}:${sv.port} · ${escapeHtml(sv.username || "—")}</span>
        </span>
        <span class="rs-item-ops">
          <button class="search-btn rs-op" data-op="connect">${t("连接")}</button>
          <button class="search-btn rs-op" data-op="copy" title="${t("复制")}">⧉</button>
          <button class="search-btn rs-op" data-op="edit" title="${t("编辑")}">✎</button>
          <button class="search-btn rs-op" data-op="del" title="${t("删除")}">🗑</button>
        </span>`;
      rowEl.style.paddingLeft = `${16 + depth * 14}px`;
      // WKWebView 不支持 HTML5 DnD，用鼠标事件模拟拖拽（跨平台可靠）
      rowEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".rs-item-ops, .rs-item-ico")) return;
        const sx = e.clientX, sy = e.clientY;
        const arm = (ev: MouseEvent) => {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return; // 未达阈值：保留监听继续等
          document.removeEventListener("mousemove", arm);
          const id = sv.id;
          rowEl.classList.add("rs-dragging");
          const blockSel = (se: Event) => se.preventDefault(); // 拖拽中禁止文本选择
          document.addEventListener("selectstart", blockSel);
          // 跟随鼠标的拖拽浮层
          const ghost = document.createElement("div");
          ghost.className = "rs-drag-ghost";
          ghost.innerHTML = `<span class="rs-drag-ghost-ico"></span><span>${escapeHtml(sv.name)}</span>`;
          document.body.appendChild(ghost);
          let target: HTMLElement | null = null;
          const track = (ev: MouseEvent) => {
            ghost.style.left = `${ev.clientX + 14}px`;
            ghost.style.top = `${ev.clientY + 10}px`;
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const grp = el?.closest<HTMLElement>(".rs-group") ?? null;
            if (grp !== target) {
              if (target) target.classList.remove("rs-drop-hover");
              target = grp;
              if (target) target.classList.add("rs-drop-hover");
            }
          };
          const up = (ev: MouseEvent) => {
            document.removeEventListener("mousemove", track);
            document.removeEventListener("mouseup", up);
            document.removeEventListener("selectstart", blockSel);
            ghost.remove();
            rowEl.classList.remove("rs-dragging");
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const grp = el?.closest<HTMLElement>(".rs-group") ?? null;
            if (target) target.classList.remove("rs-drop-hover");
            if (grp && id) this.moveSiteToGroup(id, grp.dataset.group ?? "");
          };
          document.addEventListener("mousemove", track);
          document.addEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", arm);
        document.addEventListener("mouseup", () => document.removeEventListener("mousemove", arm), { once: true });
      });
      return rowEl;
    };
    // 折叠/展开箭头：collapsed=▶（向右，点击展开），expanded=▼（向下，点击收起）
    const arrowIcon = (expanded: boolean) => {
      const fill = "#f0b429";
      const path = expanded
        ? "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"
        : "M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z";
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${path}" fill="${fill}"/></svg>`;
    };
    const groupHead = (n: GNode, depth: number) => {
      const isCollapsed = collapsed.has(n.path);
      const head = document.createElement("div");
      head.className = "rs-group" + (isCollapsed ? " collapsed" : "");
      head.dataset.group = n.path;
      head.style.paddingLeft = `${10 + depth * 14}px`;
      head.innerHTML = `<span class="rs-group-arrow">${arrowIcon(!isCollapsed)}</span><span class="rs-group-name">${escapeHtml(n.name)}</span><span class="rs-group-count">${subCount(n)}</span>`;
      head.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".rs-item-ops")) return;
        this.toggleGroup(n.path);
      });
      head.addEventListener("dragover", (e) => { e.preventDefault(); head.classList.add("rs-drop-hover"); });
      head.addEventListener("dragleave", () => head.classList.remove("rs-drop-hover"));
      head.addEventListener("drop", (e) => {
        e.preventDefault();
        head.classList.remove("rs-drop-hover");
        const id = e.dataTransfer?.getData("text/x-uec-site");
        if (id) this.moveSiteToGroup(id, n.path);
      });
      head.addEventListener("contextmenu", (e) => this.onGroupCtx(e, n));
      return head;
    };
    const walk = (n: GNode, depth: number) => {
      if (n === root) {
        // root.sites（未分组服务器）不在此渲染，统一由下方未分组区渲染一次，避免重复
        for (const ch of [...n.children.values()].sort(sortN)) walk(ch, 0);
        return;
      }
      list.appendChild(groupHead(n, depth));
      if (collapsed.has(n.path)) return;
      for (const ch of [...n.children.values()].sort(sortN)) walk(ch, depth + 1);
      for (const sv of [...n.sites].sort(sortS)) list.appendChild(row(sv, depth + 1));
    };
    walk(root, 0);
    // 未分组区（拖拽目标：拖进来即移出分组）
    const ungrouped = vis.filter((sv) => !sv.group);
    // 搜索时仅在有未分组服务器时显示未分组头（避免空头误现）；无搜索时显示作拖拽目标
    if (ungrouped.length || (root.children.size > 0 && !q)) {
      const head = document.createElement("div");
      head.className = "rs-group rs-group-ungrouped" + (root.children.size ? " rs-drop-zone" : "");
      head.innerHTML = `<span class="rs-group-arrow">${arrowIcon(true)}</span><span class="rs-group-name">${t("未分组")}</span><span class="rs-group-count">${ungrouped.length}</span>`;
      head.addEventListener("dragover", (e) => { e.preventDefault(); head.classList.add("rs-drop-hover"); });
      head.addEventListener("dragleave", () => head.classList.remove("rs-drop-hover"));
      head.addEventListener("drop", (e) => {
        e.preventDefault();
        head.classList.remove("rs-drop-hover");
        const id = e.dataTransfer?.getData("text/x-uec-site");
        if (id) this.moveSiteToGroup(id, "");
      });
      list.appendChild(head);
      for (const sv of [...ungrouped].sort(sortS)) list.appendChild(row(sv, 1));
    }
  }

  // 拖拽/移动服务器到指定分组路径（空串=未分组）
  private moveSiteToGroup(id: string, group: string) {
    const sv = this.sites.find((x) => x.id === id);
    if (!sv) return;
    if (sv.group === group) return;
    sv.group = group;
    this.saveSites();
    this.renderSites();
    this.status(t("已移动到分组 {g}", { g: group || t("未分组") }));
  }

  // 组标题右键菜单
  private onGroupCtx(e: MouseEvent, n: { name: string; path: string }) {
    if (e.button === 0 && (e.ctrlKey || e.detail > 0)) { e.preventDefault(); return; }
    e.preventDefault();
    e.stopPropagation();
    const ctx = this.el.querySelector<HTMLElement>("#rs-group-ctx");
    if (!ctx) return;
    // 打开时按当前语言填充文案（模板为构造时生成，语言切换后需动态刷新）
    const acts: Record<string, string> = {
      "new-subgroup": t("新建子分组…"),
      "rename-group": t("重命名分组"),
      "del-group": t("删除分组"),
      "collapse-all": t("折叠全部"),
      "expand-all": t("展开全部"),
    };
    ctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((it) => {
      const a = it.dataset.act;
      if (a && acts[a]) it.textContent = acts[a];
    });
    this.ctxGroup = n.path;
    ctx.style.left = `${e.clientX}px`;
    ctx.style.top = `${e.clientY}px`;
    ctx.classList.remove("hidden");
  }

  private async groupAction(act: string) {
    const g = this.ctxGroup;
    if (!g) return;
    this.ctxGroup = null;
    const affected = this.sites.filter((sv) => sv.group === g || sv.group.startsWith(g + "/"));
    if (act === "new-subgroup") {
      const name = await this.promptText(t("新建子分组…"), t("子分组名（如 华东）"), "");
      if (!name) return;
      const segs = name.split("/").map((x) => x.trim()).filter(Boolean);
      if (!segs.length) return;
      const path = g + "/" + segs.join("/");
      const list = this.groupList();
      if (list.includes(path)) { this.status(t("分组已存在")); return; }
      list.push(path);
      this.saveGroupList(list);
      this.renderSites();
      return;
    } else if (act === "rename-group") {
      const last = g.split("/").pop() || g;
      const name = await this.promptText(t("重命名分组"), t("新分组名"), last);
      if (!name || !name.trim() || name.trim() === last) return;
      const clean = name.trim();
      const prefix = g.slice(0, g.length - last.length);
      for (const sv of affected) {
        sv.group = prefix + clean + (sv.group === g ? "" : sv.group.slice(g.length));
      }
      this.saveSites();
      // 清单级联改名（含空分组）
      const list = this.groupList();
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === g) { list[i] = prefix + clean; changed = true; }
        else if (list[i].startsWith(g + "/")) { list[i] = prefix + clean + list[i].slice(g.length); changed = true; }
      }
      if (changed) this.saveGroupList(list);
      this.renderSites();
    } else if (act === "del-group") {
      if (!await this.confirm(t("删除分组 {g}？组内服务器将移到上一级，空分组将被移除。", { g }))) return;
      for (const sv of affected) sv.group = sv.group === g ? "" : sv.group.slice(g.length + 1);
      this.saveSites();
      this.saveGroupList(this.groupList().filter((pp) => pp !== g && !pp.startsWith(g + "/")));
      this.renderSites();
    } else if (act === "collapse-all") {
      this.collapseAll(true);
    } else if (act === "expand-all") {
      this.collapseAll(false);
    }
  }

  private collapseAll(collapse: boolean) {
    const all = new Set<string>();
    for (const sv of this.sites) {
      const segs = sv.group.split("/").filter(Boolean);
      let acc = "";
      for (const seg of segs) {
        acc = acc ? acc + "/" + seg : seg;
        all.add(acc);
      }
    }
    for (const g of this.groupList()) {
      const segs = g.split("/").filter(Boolean);
      let acc = "";
      for (const seg of segs) {
        acc = acc ? acc + "/" + seg : seg;
        all.add(acc);
      }
    }
    const cur = this.collapsedGroups();
    if (collapse) { for (const pp of all) cur.add(pp); }
    else { for (const pp of all) cur.delete(pp); }
    localStorage.setItem("uec.remote.groups.collapsed", JSON.stringify([...cur]));
    this.renderSites();
  }

  // 独立分组清单（空分组预建，localStorage 持久化）
  private groupList(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem("uec.remote.groups.list") || "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  }

  private saveGroupList(list: string[]) {
    localStorage.setItem("uec.remote.groups.list", JSON.stringify([...new Set(list)]));
  }

  // 列表空白右键：新建分组（支持嵌套路径，可建空文件夹）
  private async ctxNewGroup() {
    const name = await this.promptText(t("新建分组…"), t("分组路径（如 研发/算法）"), "");
    if (!name) return;
    const segs = name.split("/").map((x) => x.trim()).filter(Boolean);
    if (!segs.length) return;
    const path = segs.join("/");
    const list = this.groupList();
    if (list.includes(path)) { this.status(t("分组已存在")); return; }
    list.push(path);
    this.saveGroupList(list);
    this.renderSites();
  }

  // 复制服务器：基于原配置生成新条目（新 id，名称带副本后缀）
  private duplicateSite(id: string) {
    const s = this.sites.find((x) => x.id === id);
    if (!s) return;
    const copy: RemoteSite = { ...s, id: genId(), name: t("{name} 副本", { name: s.name }) };
    this.sites.push(copy);
    this.saveSites();
    this.renderSites();
    this.status(t("已复制服务器 {name}", { name: copy.name }));
  }

  private async deleteSite(id: string) {
    const s = this.sites.find((x) => x.id === id);
    if (!s) return;
    if (!await this.confirm(t("确定删除服务器 {name} 吗？", { name: s.name }))) return;
    // 已连接（无论是否当前激活）都先断开，避免残留会话
    if (this.sessions.has(id)) await this.disconnect(id);
    this.sites = this.sites.filter((x) => x.id !== id);
    if (this.selSiteId === id) this.selSiteId = null;
    this.saveSites();
    this.renderSites();
  }

  private async copyPath(full: string) {
    if (!full) return;
    try {
      await navigator.clipboard?.writeText(full);
      this.status(t("已复制路径"));
    } catch {
      this.status(t("复制失败"));
    }
  }

  private onGlobalKey(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.closest(".cm-editor") || tgt.closest(".xterm") || tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === "c") {
      if (!this.cur || !this.cur.selectedPaths.size || !this.id) return;
      e.preventDefault();
      this.setClipboardPaths([...this.cur.selectedPaths]);
    } else if (k === "v") {
      if (!this.clipboard) return;
      e.preventDefault();
      void this.pasteClipboard();
    }
  }

  private applyPasteState(it: HTMLElement) {    if (this.clipboard) {
      it.classList.remove("ctx-disabled");
      it.title = t("粘贴 {name}", { name: this.clipboard.name });
    } else {
      it.classList.add("ctx-disabled");
      it.title = t("请先复制文件或文件夹");
    }
  }

  private setClipboardPaths(paths: string[]) {
    if (!paths.length) return;
    // paths 已是完整路径（effectiveRemotePaths 产出），无需再 join
    const srcs = [...paths];
    const name = srcs.length > 1 ? t("选中 {n} 项", { n: srcs.length }) : (srcs[0].split("/").filter(Boolean).pop() || srcs[0]);
    this.clipboard = { srcs, name };
    this.status(t("已复制 {name}，在目标目录右键粘贴", { name }));
  }

  // 粘贴到当前浏览目录（this.path）；同名自动加序号；目录贴进自身子目录会被后端拦截；多选逐项
  private async pasteClipboard() {
    const cb = this.clipboard;
    if (!cb) {
      this.status(t("请先复制文件或文件夹"));
      return;
    }
    if (!this.id || !this.path) return;
    try {
      for (const src of cb.srcs) {
        await invoke<string>(this.isSftp() ? "sftp_copy" : "ftp_copy", {
          id: this.id,
          src,
          destDir: this.path,
        });
      }
      this.status(t("已粘贴到 {dest}", { dest: this.path }));
      void this.refresh();
    } catch (e) {
      this.showError(t("粘贴失败"), String(e));
    }
  }

  private async connectSite(s: RemoteSite, passOverride?: string, onSuccess?: () => void): Promise<void> {
    const doConn = async (pw: string) => {
      this.selSiteId = s.id;
      // 先建会话占位（让 id/proto/path 等代理指向新会话），失败时回滚
      const sess: SessionState = {
        siteId: s.id,
        connId: "",
        proto: s.proto,
        path: s.remoteDir || "/",
        expanded: new Set(),
        loading: new Set(),
        selectedPath: null,
        selectedPaths: new Set<string>(),
        selectAnchor: null,
        ctxIsDir: false,
        selNode: null,
        arcView: null,
        arcTree: [],
        arcTreeTmp: "",
        curConn: null,
        el: null,
      };
      this.sessions.set(s.id, sess);
      this.activeSiteId = s.id;
      this.proto = s.proto;
      this.status(t("连接中…"));
      const fail = (msg: string, hint: string) => {
        this.sessions.delete(s.id);
        this.activeSiteId = this.sessions.keys().next().value ?? null;
        this.setPanelTab(this.activeSiteId ? "tree" : "list");
        if (this.activeSiteId) this.activateSession(this.activeSiteId);
        this.status(t("失败: {msg}", { msg }));
        this.showError(t("连接失败"), msg + hint);
      };
      try {
        const o = {
          host: s.host,
          port: s.port,
          username: s.username,
          password: pw,
          keyPath: s.keyPath || null,
          passphrase: s.passphrase || null,
          authMethod: s.authMethod,
        };
        this.id = this.proto === "sftp"
          ? await invoke<string>("sftp_connect", o)
          : await invoke<string>("ftp_connect", o);
        this.curConn = {
          host: s.host,
          port: s.port,
          username: s.username,
          password: pw,
          keyPath: s.keyPath || null,
          passphrase: s.passphrase || null,
        };
        this.path = s.remoteDir || "/";
        this.arcView = null;
        this.arcTree = [];
        this.arcTreeTmp = "";
        this.setPanelTab("tree");
        this.activateSession(s.id, false);
        this.status(t("[{name}] 已连接", { name: s.name }) + (s.keyPath ? t("（密钥认证）") : ""));
        await this.refresh();
        // MobaXterm 式：连接成功即打开远程终端（起始于起始远程目录），文件树与终端并存
        if (this.curConn) {
          this.onOpenTerminal?.(
            { ...this.curConn },
            s.remoteDir && s.remoteDir !== "/" ? s.remoteDir : undefined,
            s.id,
          );
        }
        onSuccess?.();
      } catch (e) {
        const msg = String(e);
        let hint = "";
        if (/Authentication failed|Permission denied|denied/i.test(msg) && /^root$/i.test(s.username || "")) {
          hint = "\n\n" + t("提示：OpenSSH 常禁用 root 的密码登录（PermitRootLogin prohibit-password）。请改用普通用户登录，或在服务器开启 PermitRootLogin yes / PasswordAuthentication yes，或改用「公钥」认证。");
        }
        fail(msg, hint);
      }
    };
    if (passOverride !== undefined) return doConn(passOverride);
    if (s.password) return doConn(s.password);
    const pw = await this.promptPassword(s);
    if (pw === null) {
      this.status(t("已取消"));
      return;
    }
    return doConn(pw);
  }

  private promptPassword(s: RemoteSite): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:300px;">
        <div class="modal-title">输入密码 · ${escapeHtml(s.name)}</div>
        <div class="modal-body">
          <label class="acct-f">账户 <b>${escapeHtml(s.username || "(无用户名)")}</b> @ ${escapeHtml(s.host)} 的密码
            <input id="pw-input" type="password" class="fs-input" autofocus/>
          </label>
        </div>
        <div class="modal-actions">
          <button class="search-btn" id="pw-ok">确定</button>
          <button class="search-btn" id="pw-cancel">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector("#pw-input") as HTMLInputElement;
      const close = (v: string | null) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#pw-ok")!.addEventListener("click", () => close(input.value));
      mask.querySelector("#pw-cancel")!.addEventListener("click", () => close(null));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(null);
      });
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") close(input.value);
      });
    });
  }

  private showError(title: string, msg: string) {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `<div class="modal" style="max-width:540px;">
      <div class="modal-title">${escapeHtml(title)}</div>
      <div class="modal-body" style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;word-break:break-word;">${escapeHtml(msg)}</div>
      <div class="modal-actions">
        <button class="search-btn" id="err-ok">确定</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const done = () => mask.remove();
    mask.querySelector("#err-ok")!.addEventListener("click", done);
    mask.addEventListener("click", (e) => {
      if (e.target === mask) done();
    });
  }

  /* ---------------- FTP 账户管理器对话框 ---------------- */

  private openAccountManager(isNew = false, presetId?: string | null) {
    const draft: RemoteSite[] = this.sites.map((s) => ({ ...s }));
    let selId: string | null = presetId ?? this.selSiteId ?? (draft[0] ? draft[0].id : null);
    if (isNew || !selId || !draft.find((s) => s.id === selId)) {
      const a = newAccount();
      draft.push(a);
      selId = a.id;
    }

    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `
      <div class="modal acct-modal">
        <div class="acct-title">${t("FTP 账户管理器")}</div>
        <div class="acct-body">
          <div class="acct-list">
            <div class="acct-list-actions">
              <button id="acct-new" class="search-btn">${t("+ 新建")}</button>
              <button id="acct-dup" class="search-btn">${t("复制")}</button>
              <button id="acct-del" class="search-btn">${t("删除")}</button>
            </div>
            <ul id="acct-items" class="acct-items"></ul>
          </div>
          <div class="acct-props">
            <div class="acct-tabs">
              <button data-tab="general" class="acct-tab-btn active">${t("常规")}</button>
              <button data-tab="advanced" class="acct-tab-btn">${t("高级")}</button>
              <button data-tab="ssh" class="acct-tab-btn">${t("SFTP/SSH")}</button>
            </div>
            <div class="acct-tabpanel" data-tab="general">
              <label class="acct-f">${t("账户名称")}<input id="acct-name" class="fs-input"/></label>
              <label class="acct-f">${t("分组（可选）")}
                <span class="acct-group-wrap">
                  <input id="acct-group" class="fs-input" placeholder="${t("未分组")}" autocomplete="off"/>
                  <div id="acct-group-pick" class="acct-group-pick hidden"></div>
                </span>
              </label>
              <div class="acct-f-row">
                <label class="acct-f" style="flex:1">${t("协议")}
                  <select id="acct-proto" class="fs-input">
                    <option value="ftp">FTP</option>
                    <option value="sftp">SFTP</option>
                    <option value="ftps">FTPS</option>
                  </select>
                </label>
                <label class="acct-f" style="flex:1">${t("端口")}<input id="acct-port" class="fs-input"/></label>
              </div>
              <label class="acct-f">${t("服务器")}<input id="acct-host" class="fs-input" placeholder="${t("例如 ftp.example.com")}"/></label>
              <div class="acct-f-row">
                <label class="acct-f" style="flex:1">${t("用户名")}<input id="acct-user" class="fs-input"/></label>
                <label class="acct-f" style="flex:1">${t("密码")}<input id="acct-pass" type="password" class="fs-input"/></label>
              </div>
              <label class="acct-check"><input id="acct-savepass" type="checkbox"/> ${t("记住密码")}</label>
              <label class="acct-f" id="acct-auth-row">${t("认证方式")}
                <select id="acct-auth" class="fs-input">
                  <option value="auto">${t("自动")}</option>
                  <option value="password">${t("仅密码")}</option>
                  <option value="keyboard">${t("键盘交互")}</option>
                  <option value="publickey">${t("仅公钥")}</option>
                </select>
              </label>
              <label class="acct-f">${t("起始远程目录")}<input id="acct-rdir" class="fs-input" placeholder="${t("/ （留空用根目录）")}"/></label>
              <label class="acct-f">${t("起始本地目录")}<input id="acct-ldir" class="fs-input" placeholder="${t("留空用当前目录")}"/></label>
            </div>
            <div class="acct-tabpanel hidden" data-tab="advanced">
              <label class="acct-f">${t("连接超时（秒）")}<input id="acct-timeout" type="number" class="fs-input"/></label>
              <label class="acct-f">${t("失败后重试次数")}<input id="acct-retry" type="number" class="fs-input"/></label>
              <label class="acct-f">${t("传输模式")}
                <select id="acct-xfer" class="fs-input">
                  <option value="auto">${t("自动")}</option>
                  <option value="ascii">ASCII</option>
                  <option value="binary">${t("二进制")}</option>
                </select>
              </label>
              <label class="acct-check"><input id="acct-pasv" type="checkbox"/> ${t("被动模式 (PASV)（FTP/FTPS）")}</label>
            </div>
            <div class="acct-tabpanel hidden" data-tab="ssh">
              <label class="acct-f">${t("私钥文件")}
                <span class="acct-keyrow"><input id="acct-key" class="fs-input" placeholder="${t("私钥路径（可选）")}"/><button id="acct-keybrowse" class="search-btn">…</button></span>
              </label>
              <div class="acct-keygen">
                <button class="search-btn" id="acct-genkey" type="button">${t("生成 SSH 密钥对…")}</button>
                <textarea id="acct-pubkey" class="fs-input acct-pubkey" readonly placeholder="${t("生成后此处显示公钥，请将其添加到服务器的 ~/.ssh/authorized_keys")}"></textarea>
                <button class="search-btn" id="acct-copypub" type="button">${t("复制公钥")}</button>
                <div class="acct-hint">${t("未勾「记住密码」时，连接会提示输入私钥口令。")}</div>
              </div>
              <label class="acct-f">${t("私钥口令")}<input id="acct-keypass" type="password" class="fs-input"/></label>
            </div>
          </div>
        </div>
        <div class="acct-foot">
          <button id="acct-connect" class="search-btn">${t("连接")}</button>
          <span class="acct-spacer"></span>
          <button id="acct-ok" class="search-btn primary">${t("保存")}</button>
          <button id="acct-cancel" class="search-btn">${t("取消")}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const q = <T extends HTMLElement = HTMLElement>(s: string) => mask.querySelector<T>(s)!;
    const qSel = (s: string) => mask.querySelector<HTMLSelectElement>(s)!;
    const qInp = (s: string) => mask.querySelector<HTMLInputElement>(s)!;

    const renderList = () => {
      const ul = q("#acct-items");
      ul.innerHTML = "";
      if (draft.length === 0) {
        const empty = document.createElement("li");
        empty.className = "acct-empty";
        empty.textContent = t("（没有账户，点「+ 新建」）");
        ul.appendChild(empty);
        return;
      }
      for (const s of draft) {
        const li = document.createElement("li");
        li.className = "acct-item" + (s.id === selId ? " active" : "");
        li.dataset.id = s.id;
        li.innerHTML = `<span class="acct-item-name">${escapeHtml(s.name)}</span><span class="acct-item-sub">${s.proto.toUpperCase()} · ${escapeHtml(s.host || "—")}</span>`;
        li.addEventListener("click", () => {
          commit();
          selId = s.id;
          renderList();
          loadSel();
        });
        ul.appendChild(li);
      }
    };

    const loadSel = () => {
      const s = draft.find((x) => x.id === selId);
      const disabled = !s;
      (q("#acct-name") as HTMLInputElement).disabled = disabled;
      qSel("#acct-proto").disabled = disabled;
      qInp("#acct-port").disabled = disabled;
      qInp("#acct-host").disabled = disabled;
      qInp("#acct-user").disabled = disabled;
      qInp("#acct-pass").disabled = disabled;
      qInp("#acct-savepass").disabled = disabled;
      qInp("#acct-rdir").disabled = disabled;
      qInp("#acct-ldir").disabled = disabled;
      qInp("#acct-timeout").disabled = disabled;
      qInp("#acct-retry").disabled = disabled;
      qSel("#acct-xfer").disabled = disabled;
      qInp("#acct-pasv").disabled = disabled;
      qSel("#acct-auth").disabled = disabled;
      qInp("#acct-key").disabled = disabled;
      qInp("#acct-keypass").disabled = disabled;
      if (!s) return;
      qInp("#acct-name").value = s.name;
      qInp("#acct-group").value = s.group || "";
      qSel("#acct-proto").value = s.proto;
      qInp("#acct-port").value = String(s.port);
      qInp("#acct-host").value = s.host;
      qInp("#acct-user").value = s.username;
      qInp("#acct-pass").value = s.password;
      qInp("#acct-savepass").checked = s.savePassword;
      qInp("#acct-rdir").value = s.remoteDir;
      qInp("#acct-ldir").value = s.localDir;
      qInp("#acct-timeout").value = String(s.timeout);
      qInp("#acct-retry").value = String(s.retry);
      qSel("#acct-xfer").value = s.xfer;
      qInp("#acct-pasv").checked = s.passive;
      qSel("#acct-auth").value = s.authMethod;
      qInp("#acct-key").value = s.keyPath;
      qInp("#acct-keypass").value = s.passphrase;
      q("#acct-auth-row").style.display = s.proto === "ftp" ? "none" : "";
    };

    const commit = () => {
      const s = draft.find((x) => x.id === selId);
      if (!s) return;
      s.name = qInp("#acct-name").value.trim() || "未命名账户";
      s.group = qInp("#acct-group").value.trim();
      s.proto = qSel("#acct-proto").value as RemoteSite["proto"];
      const portRaw = qInp("#acct-port").value.trim();
      s.port = parseInt(portRaw || String(defaultPort(s.proto)), 10) || defaultPort(s.proto);
      s.host = qInp("#acct-host").value.trim();
      s.username = qInp("#acct-user").value;
      s.password = qInp("#acct-pass").value;
      s.savePassword = qInp("#acct-savepass").checked;
      s.remoteDir = qInp("#acct-rdir").value.trim() || "/";
      s.localDir = qInp("#acct-ldir").value.trim();
      s.timeout = parseInt(qInp("#acct-timeout").value || "30", 10) || 30;
      s.retry = parseInt(qInp("#acct-retry").value || "3", 10) || 3;
      s.xfer = qSel("#acct-xfer").value as RemoteSite["xfer"];
      s.passive = qInp("#acct-pasv").checked;
      s.authMethod = qSel("#acct-auth").value as RemoteSite["authMethod"];
      s.keyPath = qInp("#acct-key").value.trim();
      s.passphrase = qInp("#acct-keypass").value;
    };

    const finalize = () => {
      for (const s of draft) if (!s.savePassword) s.password = "";
      this.sites = draft;
      this.saveSites();
    };

    const close = () => mask.remove();

    // 分组自定义下拉：已用分组 + 独立清单（空分组），点击回填
    const groupInput = qInp("#acct-group");
    const groupPick = q("#acct-group-pick") as HTMLElement;
    const buildGroupPick = () => {
      const list = [...new Set([
        ...this.sites.map((x) => x.group).filter(Boolean),
        ...this.groupList(),
      ])].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
      groupPick.innerHTML = "";
      if (!list.length) {
        const d = document.createElement("div");
        d.className = "acct-group-pick-empty";
        d.textContent = t("暂无分组，可直接输入新路径");
        groupPick.appendChild(d);
        return;
      }
      for (const g of list) {
        const item = document.createElement("div");
        item.className = "acct-group-pick-item";
        item.textContent = g;
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          groupInput.value = g;
          groupPick.classList.add("hidden");
        });
        groupPick.appendChild(item);
      }
    };
    let pickTimer: ReturnType<typeof setTimeout> | undefined;
    groupInput.addEventListener("focus", () => {
      clearTimeout(pickTimer);
      buildGroupPick();
      groupPick.classList.remove("hidden");
    });
    groupInput.addEventListener("input", () => {
      buildGroupPick();
      groupPick.classList.remove("hidden");
    });
    groupInput.addEventListener("blur", () => {
      pickTimer = setTimeout(() => groupPick.classList.add("hidden"), 150);
    });
    // 点击下拉外部（含账户列表切换）立即关闭；点击下拉项由 mousedown preventDefault 保持
    mask.addEventListener("mousedown", (e) => {
      if (!groupPick.contains(e.target as Node) && e.target !== groupInput) {
        clearTimeout(pickTimer);
        groupPick.classList.add("hidden");
      }
    });

    // tabs
    mask.querySelectorAll<HTMLElement>(".acct-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        mask.querySelectorAll(".acct-tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab!;
        mask.querySelectorAll<HTMLElement>(".acct-tabpanel").forEach((p) => {
          p.classList.toggle("hidden", p.dataset.tab !== tab);
        });
      });
    });

    // proto auto-port
    qSel("#acct-proto").addEventListener("change", () => {
      const cur = qInp("#acct-port").value.trim();
      if (cur === "" || cur === "21" || cur === "22") {
        qInp("#acct-port").value = String(defaultPort(qSel("#acct-proto").value));
      }
      q("#acct-auth-row").style.display = qSel("#acct-proto").value === "ftp" ? "none" : "";
    });

    // key browse
    q("#acct-keybrowse").addEventListener("click", async () => {
      const picked = await dialogOpen({ multiple: false, title: t("选择私钥") });
      if (picked) qInp("#acct-key").value = picked as string;
    });
    q("#acct-genkey").addEventListener("click", async () => {
      const path = await dialogSave({ defaultPath: "uec_id_ed25519", title: t("保存私钥到") });
      if (!path) return;
      const pass = qInp("#acct-keypass").value;
      try {
        const res = await invoke<{ private_path: string; public_key: string }>("ssh_generate_key", {
          path,
          passphrase: pass || null,
        });
        qInp("#acct-key").value = res.private_path;
        qSel("#acct-auth").value = "publickey";
        (q("#acct-pubkey") as HTMLTextAreaElement).value = res.public_key;
        this.status(t("已生成密钥：{path}", { path: res.private_path }));
      } catch (e) {
        this.status(t("生成失败: {e}", { e: String(e) }));
      }
    });
    q("#acct-copypub").addEventListener("click", () => {
      const v = (q("#acct-pubkey") as HTMLTextAreaElement).value;
      if (!v) return;
      navigator.clipboard?.writeText(v).then(
        () => this.status(t("已复制公钥")),
        () => this.status(t("复制失败")),
      );
    });

    // list actions
    q("#acct-new").addEventListener("click", () => {
      commit();
      const a = newAccount();
      draft.push(a);
      selId = a.id;
      renderList();
      loadSel();
      qInp("#acct-name").focus();
      qInp("#acct-name").select();
    });
    q("#acct-dup").addEventListener("click", () => {
      commit();
      const src = draft.find((x) => x.id === selId);
      if (!src) return;
      const c: RemoteSite = { ...src, id: genId(), name: src.name + " 副本" };
      draft.push(c);
      selId = c.id;
      renderList();
      loadSel();
    });
    q("#acct-del").addEventListener("click", () => {
      if (!selId) return;
      const idx = draft.findIndex((x) => x.id === selId);
      if (idx < 0) return;
      draft.splice(idx, 1);
      selId = draft[0] ? draft[0].id : null;
      renderList();
      loadSel();
    });

    // footer
    q("#acct-cancel").addEventListener("click", () => close());
    q("#acct-ok").addEventListener("click", () => {
      commit();
      finalize();
      this.renderSites();
      close();
    });
    q("#acct-connect").addEventListener("click", () => {
      commit();
      finalize();
      this.renderSites();
      const s = draft.find((x) => x.id === selId);
      if (!s) return;
      // 连接成功才关闭对话框；失败则保留以便修改重试
      void this.connectSite(s, undefined, () => close());
    });

    mask.addEventListener("click", (e) => {
      if (e.target === mask) close();
    });

    renderList();
    loadSel();
  }

  /* ---------------- 连接后的浏览/操作 ---------------- */

  // 断开指定服务器（缺省=当前）；断开的会话无目录树视图，有会话则切到剩余第一个
  async disconnect(siteId?: string) {
    const sid = siteId ?? this.activeSiteId;
    if (!sid) return;
    const s = this.sessions.get(sid);
    if (!s) return;
    if (s.connId) {
      const cmd = s.proto === "sftp" ? "sftp_disconnect" : "ftp_disconnect";
      // 兜底：Rust 端全局锁可能被慢网络 IO 占用（sftp_list/readdir 持锁），
      // 最多等 3 秒，超时也立即清理界面；Rust 端连接由未完成的 invoke 继续清理。
      const done = invoke(cmd, { id: s.connId }).catch(() => {});
      await Promise.race([done, new Promise<void>((r) => setTimeout(r, 3000))]);
    }
    this.sessions.delete(sid);
    // MobaXterm 式：断开会话时连同该服务器的终端一起关闭
    this.onCloseTerms?.(sid);
    if (this.activeSiteId === sid) {
      this.activeSiteId = this.sessions.keys().next().value ?? null;
    }
    if (this.sessions.size === 0) {
      const site = this.sites.find((x) => x.id === sid);
      this.setPanelTab("list");
      this.clearConnView();
      if (site) this.listStatus(t("已断开 {name}", { name: site.name }));
      return;
    }
    this.activateSession(this.activeSiteId!);
  }

  // 无会话时清空目录树视图（连接条/路径/树），避免残留旧连接造成"点了没反应"
  private clearConnView() {
    const info = this.q<HTMLElement>("#rs-conn-info");
    if (info) info.textContent = "";
    const path = this.q<HTMLElement>("#ftp-path");
    if (path) path.textContent = "";
    const tree = this.q<HTMLElement>("#ftp-tree");
    if (tree) tree.innerHTML = "";
    const bar = this.q<HTMLElement>("#rs-connbar");
    if (bar) bar.classList.add("hidden");
    this.status(t("未连接任何服务器，请先在「列表」中连接"));
  }

  // 列表顶部短暂提示（断开等操作的即时反馈）
  private listStatus(msg: string) {
    const el = this.q<HTMLElement>("#rs-list-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(this.listStatusTimer);
    this.listStatusTimer = window.setTimeout(() => el.classList.add("hidden"), 3000);
  }

  // 面板级 tab：列表 / 目录树（目录树为单例，跟随当前激活会话）
  private setPanelTab(which: "list" | "tree") {
    this.el.querySelector("#rs-panel-list")!.classList.toggle("active", which === "list");
    this.el.querySelector("#rs-panel-tree")!.classList.toggle("active", which === "tree");
    this.el.querySelector("#rs-list-view")!.classList.toggle("hidden", which !== "list");
    this.el.querySelector("#rs-conn-view")!.classList.toggle("hidden", which !== "tree");
    if (which === "list") {
      this.renderSites();
    } else if (this.sessions.size === 0) {
      this.clearConnView();
    }
  }

  // 激活指定会话：单例目录树视图跟随（数据在会话内存中，重渲染树）
  activateSession(siteId: string, doRefresh = true) {
    if (!this.sessions.has(siteId)) return;
    this.activeSiteId = siteId;
    const s = this.sessions.get(siteId)!;
    const site = this.sites.find((x) => x.id === siteId);
    const bar = this.q<HTMLElement>("#rs-connbar");
    if (bar) bar.classList.remove("hidden");
    const info = this.el.querySelector<HTMLElement>("#rs-conn-info");
    if (info) info.textContent = `${s.proto.toUpperCase()} · ${site ? site.host : ""}:${site ? site.port : ""}`;
    this.renderSites();
    if (doRefresh) void this.refresh();
  }

  // 打开终端：工具栏入口（当前连接）与右键入口（cd 到目录）
  private openTerminalHere(dir?: string) {
    if (!this.onOpenTerminal || !this.curConn) {
      this.status(t("请先连接一个账户"));
      return;
    }
    const conn: TermParams = { ...this.curConn };
    if (dir) conn.initialDir = dir;
    this.onOpenTerminal(conn, dir, this.activeSiteId ?? undefined);
  }

  // 显示隐藏文件开关（由 app 层调用并持久化）
  setShowHidden(v: boolean) {
    this.showHidden = v;
    void this.refresh();
  }

  // 按站点 ID 取账户名称（终端 tab 标题用），取不到回退主机名
  getSiteName(siteId: string): string {
    const s = this.sites.find((x) => x.id === siteId);
    return s ? s.name || s.host : "";
  }

  async refresh(): Promise<boolean> {
    if (!this.id) return false;
    this.status(t("读取目录…"));
    try {
      const res = this.isSftp()
        ? await invoke<FtpListResult>("sftp_list", { id: this.id, path: this.path })
        : await invoke<FtpListResult>("ftp_list", { id: this.id });
      const pwd = this.isSftp() ? this.path : res.pwd;
      if (!this.isSftp()) this.path = pwd;
      this.arcView = null;
      this.selectedNode = null;
      this.renderPathBar();
      const tree = this.q<HTMLElement>("#ftp-tree");
      if (!tree) return false;
      tree.innerHTML = "";
      const frag = document.createDocumentFragment();
      if (!this.isSftp() && pwd !== "/") frag.appendChild(this.node("..", true, 0, "", true));
      let shown = 0;
      const kw = this.filterText.toLowerCase();
      const filtered = kw ? res.entries.filter((e) => e.name.toLowerCase().includes(kw)) : res.entries;
      for (const e of sortEntries(filtered, this.sort)) {
        if (!this.showHidden && e.name.startsWith(".")) continue;
        shown++;
        const full = this.isSftp() ? join(this.path, e.name) : e.name;
        frag.appendChild(this.node(e.name, e.is_dir, e.size, full, false, e.modified));
      }
      tree.appendChild(frag);
      await this.expandFrom(tree);
      this.status(t("已连接 · {n} 项", { n: shown }));
      return true;
    } catch (e) {
      // 失败：保留上次成功的树，调用方决定是否回滚 path
      this.status(t("读取失败: {e}", { e: String(e) }));
      return false;
    }
  }

  private node(name: string, isDir: boolean, size = 0, fullPath = "", isUp = false, modified?: number): HTMLElement {
    const div = document.createElement("div");
    div.className = "ft-node ft-remote-item " + (isDir ? "ft-dir" : "ft-file");
    div.dataset.name = name;
    div.dataset.dir = isDir ? "1" : "0";
    if (size > 0) div.dataset.size = String(size);
    if (fullPath) div.dataset.path = fullPath;
    div.dataset.actions = isUp ? "up" : "";
    const arrow = isDir ? "▸" : "";
    const ico = isDir ? "ft-dir-ico" : `ft-${extFor(name)}`;
    div.innerHTML = `<span class="ft-arrow">${arrow}</span><span class="ft-ico ${ico}">${isDir ? "" : iconLabel(extFor(name))}</span><span class="ft-name">${escapeHtml(name)}</span><span class="ft-size">${isUp || isDir ? "" : fmtSize(size)}</span><span class="ft-kind">${isUp || isDir ? "" : escapeHtml(kindLabel(name))}</span><span class="ft-time">${isUp ? "" : fmtTime(modified)}</span>`;
    return div;
  }

  private async toggleExpand(elm: HTMLElement) {
    if (!this.id) return;
    const path = elm.dataset.path!;
    const arrow = elm.querySelector<HTMLElement>(".ft-arrow")!;
    const existing = elm.nextElementSibling;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      elm.classList.remove("expanded");
      arrow.textContent = "▸";
      if (existing && existing.classList.contains("ft-children")) existing.remove();
      return;
    }
    this.expanded.add(path);
    elm.classList.add("expanded");
    arrow.textContent = "▾";
    await this.loadChildren(elm);
  }

  // FTP 目录展开：临时列出子目录内容（连接目录不变）
  private async toggleFtpExpand(elm: HTMLElement) {
    if (!this.id) return;
    const path = elm.dataset.path || elm.dataset.name!;
    const arrow = elm.querySelector<HTMLElement>(".ft-arrow")!;
    const existing = elm.nextElementSibling;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      elm.classList.remove("expanded");
      arrow.textContent = "▸";
      if (existing && existing.classList.contains("ft-children")) existing.remove();
      return;
    }
    this.expanded.add(path);
    elm.classList.add("expanded");
    arrow.textContent = "▾";
    await this.loadChildrenFtp(elm);
  }

  private async loadChildrenFtp(elm: HTMLElement): Promise<void> {
    const path = elm.dataset.path || elm.dataset.name!;
    if (this.loading.has(path)) return;
    this.loading.add(path);
    const box = document.createElement("div");
    box.className = "ft-children";
    box.innerHTML = `<div class="ft-loading">${t("读取中…")}</div>`;
    elm.after(box);
    try {
      const res = await invoke<FtpListResult>("ftp_list", { id: this.id, path });
      box.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const e of sortEntries(res.entries, this.sort)) {
        if (!this.showHidden && e.name.startsWith(".")) continue;
        frag.appendChild(this.node(e.name, e.is_dir, e.size, join(path, e.name), false, e.modified));
      }
      box.appendChild(frag);
    } catch (e) {
      // 展开失败：剔除该路径，避免后续恢复继续尝试
      this.expanded.delete(path);
      elm.classList.remove("expanded");
      const arrow = elm.querySelector<HTMLElement>(".ft-arrow");
      if (arrow) arrow.textContent = "▸";
      box.innerHTML = `<div class="ft-loading">${t("失败: {e}", { e: String(e) })}</div>`;
    } finally {
      this.loading.delete(path);
    }
  }

  // 加载某目录的子节点（展开 / 恢复展开共用，按协议分派）
  private async loadChildren(elm: HTMLElement): Promise<void> {
    if (this.isSftp()) {
      await this.loadChildrenSftp(elm);
      return;
    }
    await this.loadChildrenFtp(elm);
  }

  private async loadChildrenSftp(elm: HTMLElement): Promise<void> {
    const path = elm.dataset.path!;
    if (this.loading.has(path)) return;
    this.loading.add(path);
    const box = document.createElement("div");
    box.className = "ft-children";
    box.innerHTML = `<div class="ft-loading">${t("读取中…")}</div>`;
    elm.after(box);
    try {
      const res = await invoke<FtpListResult>("sftp_list", { id: this.id, path });
      box.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const e of sortEntries(res.entries, this.sort)) {
        if (!this.showHidden && e.name.startsWith(".")) continue;
        frag.appendChild(this.node(e.name, e.is_dir, e.size, join(path, e.name), false, e.modified));
      }
      box.appendChild(frag);
    } catch (e) {
      // 展开失败：剔除该路径，避免后续恢复继续尝试
      this.expanded.delete(path);
      elm.classList.remove("expanded");
      const arrow = elm.querySelector<HTMLElement>(".ft-arrow");
      if (arrow) arrow.textContent = "▸";
      box.innerHTML = `<div class="ft-loading">${t("失败: {e}", { e: String(e) })}</div>`;
    } finally {
      this.loading.delete(path);
    }
  }

  // 递归恢复 expanded 集合中已展开的目录（refresh 重绘后调用）
  private async expandFrom(container: HTMLElement): Promise<void> {
    const dirs = Array.from(container.querySelectorAll<HTMLElement>(".ft-dir"));
    for (const elm of dirs) {
      const path = elm.dataset.path;
      if (!path || !this.expanded.has(path)) continue;
      elm.classList.add("expanded");
      const arrow = elm.querySelector<HTMLElement>(".ft-arrow");
      if (arrow) arrow.textContent = "▾";
      await this.loadChildren(elm);
      const box = elm.nextElementSibling;
      if (box && box.classList.contains("ft-children")) await this.expandFrom(box as HTMLElement);
    }
  }

  private cmdInto(name: string) {
    if (!this.id || this.isSftp()) return;
    this.status("…");
    this.expanded.clear();
    invoke<string>("ftp_cwd", { id: this.id, path: name })
      .then(() => this.refresh())
      .catch((e) => this.status(t("失败: {e}", { e: String(e) })));
  }

  private cmdUp() {
    if (!this.id) return;
    if (this.arcView) {
      // 归档视图下：退出归档返回文件树
      this.exitArcView();
      return;
    }
    if (this.isSftp()) {
      // 真上跳：path 去掉末段（失败回滚）
      const prev = this.path;
      const p = this.path || "/";
      const parent = p === "/" ? "/" : p.replace(/\/+$/, "").replace(/[^/]*$/, "") || "/";
      this.expanded.clear();
      this.path = parent;
      void (async () => {
        if (!(await this.refresh())) this.path = prev;
      })();
      return;
    }
    this.expanded.clear();
    invoke<string>("ftp_cwd", { id: this.id, path: ".." })
      .then(() => this.refresh())
      .catch((e) => this.status(t("失败: {e}", { e: String(e) })));
  }

  // 退出归档进入视图，返回远程文件树当前目录
  private exitArcView() {
    this.arcView = null;
    void this.refresh();
  }

  // Finder 选中：单击名称仅高亮；additive=true 时 ⌘/Ctrl+单击 加选/减选
  private selectNode(node: HTMLElement, additive = false) {
    if (!this.cur) return;
    if (!additive) {
      this.cur.selectedPaths.clear();
      this.cur.selectedPaths.add(this.remotePathOf(node));
      this.cur.selectAnchor = node.dataset.path || node.dataset.name || null;
    } else {
      const key = this.remotePathOf(node);
      if (this.cur.selectedPaths.has(key)) {
        this.cur.selectedPaths.delete(key);
        this.selectedPath = null;
      } else {
        this.cur.selectedPaths.add(key);
        this.cur.selectAnchor = key;
      }
    }
    this.selectedPath = node.dataset.path || node.dataset.name || null;
    this.selectedNode = node;
    this.syncRemoteSelected();
  }

  // 节点 → 完整远程路径（SFTP 绝对路径 / FTP join 当前 cwd）
  private remotePathOf(node: HTMLElement): string {
    const full = node.dataset.path || node.dataset.name!;
    return this.isSftp() ? full : join(this.path, full);
  }

  private clearRemoteMulti() {
    if (!this.cur) return;
    if (!this.cur.selectedPaths.size && !this.selectedPath) return;
    this.cur.selectedPaths.clear();
    this.cur.selectAnchor = null;
    this.selectedPath = null;
    this.syncRemoteSelected();
  }

  private syncRemoteSelected() {
    if (!this.cur) return;
    const treeEl = this.el.querySelector<HTMLElement>("#ftp-tree");
    treeEl?.querySelectorAll<HTMLElement>("[data-name]").forEach((n) => {
      n.classList.toggle("ft-selected", this.cur!.selectedPaths.has(this.remotePathOf(n)));
    });
  }

  /** 右键生效路径列表：右键节点在多选中则取多选，否则取右键节点（完整路径） */
  private effectiveRemotePaths(): string[] {
    if (!this.cur || !this.ctxNode) return [];
    const nodeKey = this.remotePathOf(this.ctxNode);
    if (this.cur.selectedPaths.size > 1 && this.cur.selectedPaths.has(nodeKey)) {
      return [...this.cur.selectedPaths];
    }
    return [nodeKey];
  }

  // Shift+单击 范围选（按树内可见顺序）
  private selectRemoteRange(target: HTMLElement) {
    if (!this.cur) return;
    const treeEl = this.el.querySelector<HTMLElement>("#ftp-tree");
    if (!treeEl) return;
    const nodes = [...treeEl.querySelectorAll<HTMLElement>("[data-name]")].filter(
      (n) => n.dataset.actions !== "up" && (n.dataset.path || n.dataset.name),
    );
    const tIdx = nodes.indexOf(target);
    if (tIdx < 0) return;
    const aIdx = nodes.findIndex((n) => this.cur!.selectAnchor === (n.dataset.path || n.dataset.name) || this.cur!.selectAnchor === this.remotePathOf(n));
    if (aIdx < 0) {
      this.selectNode(target, false);
      return;
    }
    const [lo, hi] = aIdx <= tIdx ? [aIdx, tIdx] : [tIdx, aIdx];
    this.cur.selectedPaths.clear();
    this.selectedPath = target.dataset.path || target.dataset.name || null;
    this.selectedNode = target;
    for (let i = lo; i <= hi; i++) {
      this.cur.selectedPaths.add(this.remotePathOf(nodes[i]));
    }
    this.cur.selectAnchor = target.dataset.path || target.dataset.name || null;
    this.syncRemoteSelected();
  }

  // 路径栏：SFTP 可点击面包屑；FTP 只读；归档视图为虚拟面包屑
  private renderPathBar() {
    const bar = this.q<HTMLElement>("#ftp-path");
    if (!bar) return;
    // 路径栏右侧的操作按钮（刷新 / 显示隐藏文件），随路径栏 flex 垂直居中
    const btns =
      `<button id="sb-refresh-remote" class="sb-hidden sb-refresh" title="${t("刷新")}">` +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' +
      "</button>" +
      `<button id="sb-hidden-remote" class="sb-hidden${this.showHidden ? " on" : ""}" title="${t(this.showHidden ? "隐藏隐藏文件" : "显示隐藏文件")}">` +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
      "</button>";
    bar.innerHTML = "";
    bar.classList.remove("ft-crumbs");
    if (this.arcView) {
      const av = this.arcView;
      const segs = av.dir ? av.dir.split("/") : [];
      const crumbs: Array<{ label: string; dir: string; exit?: boolean }> = [
        { label: "← 返回文件树", dir: "", exit: true },
        { label: av.arcName, dir: "" },
      ];
      let acc = "";
      for (const s of segs) {
        acc = acc ? `${acc}/${s}` : s;
        crumbs.push({ label: s, dir: acc });
      }
      bar.innerHTML =
        crumbs
          .map((c) => `<span class="ft-crumb${c.exit ? " ft-crumb-exit" : ""}" data-exit="${c.exit ? "1" : ""}" data-kind="arc" data-dir="${escapeHtml(c.dir)}">${escapeHtml(c.label)}</span>`)
          .join('<span class="ft-crumb-sep">/</span>') + btns;
      bar.classList.add("ft-crumbs");
      bar.querySelectorAll<HTMLElement>(".ft-crumb").forEach((el) => {
        el.addEventListener("click", () => {
          if (el.dataset.exit === "1") {
            this.exitArcView();
            return;
          }
          if (this.arcView) {
            this.arcView.dir = el.dataset.dir!;
            this.renderRemoteArcView();
          }
        });
      });
      return;
    }
    if (this.isSftp()) {
      const pwd = this.path || "/";
      const parts = pwd.split("/").filter(Boolean);
      const crumbs: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
      let acc = "";
      for (const p of parts) {
        acc += "/" + p;
        crumbs.push({ label: p, path: acc });
      }
      bar.innerHTML =
        crumbs
          .map((c) => `<span class="ft-crumb" data-kind="fs" data-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</span>`)
          .join('<span class="ft-crumb-sep">/</span>') + btns;
      bar.classList.add("ft-crumbs");
      bar.querySelectorAll<HTMLElement>(".ft-crumb").forEach((el) => {
        el.addEventListener("click", () => this.enterRemoteFsPath(el.dataset.path!));
      });
      return;
    }
    bar.textContent = this.path || "/";
  }

  // 面包屑点击：SFTP 切换到指定目录（失败回滚）
  private enterRemoteFsPath(path: string) {
    if (!this.id) return;
    const prev = this.path;
    this.expanded.clear();
    this.path = path;
    void (async () => {
      if (!(await this.refresh())) this.path = prev;
    })();
  }

  // 双击归档文件：进入归档根视图
  private async enterRemoteArchiveRoot(node: HTMLElement) {
    if (!this.id) return;
    const name = node.dataset.name!;
    const full = node.dataset.path || name;
    const tmp = await this.ensureArchiveTmp(full, name, Number(node.dataset.size || 0));
    if (!tmp) return;
    await this.loadRemoteArcTree(tmp);
    if (!this.arcTree.length) return;
    this.arcView = { tmp, kind: archiveKindOf(name), arcName: name, remotePath: full, dir: "" };
    this.renderRemoteArcView();
    this.renderPathBar();
  }

  // 双击/箭头进入归档内虚拟目录
  private async enterRemoteArcDir(node: HTMLElement) {
    const tmp = node.dataset.tmp!;
    await this.loadRemoteArcTree(tmp);
    if (!this.arcTree.length) return;
    this.arcView = {
      tmp,
      kind: node.dataset.kind!,
      arcName: node.dataset.arcName!,
      remotePath: node.dataset.remotePath!,
      dir: node.dataset.entry || "",
    };
    this.renderRemoteArcView();
    this.renderPathBar();
  }

  private async loadRemoteArcTree(tmp: string) {
    if (this.arcTreeTmp === tmp && this.arcTree.length) return;
    try {
      const entries = await invoke<ArchiveEntry[]>("archive_list", { path: tmp });
      this.arcTree = buildArchiveTree(entries);
      this.arcTreeTmp = tmp;
    } catch (e) {
      this.status(t("读取归档失败: {e}", { e: String(e) }));
      this.arcTree = [];
    }
  }

  // 归档虚拟节点右键动作：打开 / 复制路径 / 刷新归档 / 提取到本地
  private async arcCtxAction(act: string, node: HTMLElement | null) {
    if (!node) return;
    if (act === "arc-open") {
      if (node.classList.contains("ft-dir")) {
        // 目录：进入该虚拟目录（与双击一致，兼容进入视图与树内展开两种模式）
        void this.enterRemoteArcDir(node);
      } else {
        this.openRemoteVFile(node);
      }
      return;
    }
    if (act === "arc-copypath") {
      const p = `${node.dataset.arcName}!/${node.dataset.entry}`;
      try {
        await navigator.clipboard.writeText(p);
        this.status(t("已复制路径"));
      } catch {
        this.status(t("复制失败"));
      }
      return;
    }
    if (act === "arc-refresh") {
      if (this.arcView) {
        // 进入视图：强制重读归档列表
        this.arcTreeTmp = "";
        this.arcTree = [];
        await this.loadRemoteArcTree(this.arcView.tmp);
        if (this.arcTree.length) {
          this.renderRemoteArcView();
          this.renderPathBar();
        }
      } else {
        // 树内展开的 zip：收起后重新展开（重读列表）
        const full = node.dataset.path || node.dataset.name!;
        const arrow = node.querySelector<HTMLElement>(".ft-arrow");
        this.expanded.delete(full);
        const existing = node.nextElementSibling;
        if (existing && existing.classList.contains("ft-children")) existing.remove();
        node.classList.remove("expanded");
        if (arrow) arrow.textContent = "▸";
        await this.archiveExpand(node);
      }
      this.status(t("归档已刷新"));
      return;
    }
    if (act === "arc-extract") {
      await this.extractRemoteEntry(node);
    }
  }

  // 提取远程归档条目到本地目录（从已下载的归档临时副本提取）
  private async extractRemoteEntry(node: HTMLElement) {
    const tmp = node.dataset.tmp!;
    const entry = node.dataset.entry!;
    const isDir = node.classList.contains("ft-dir");
    const arcName = node.dataset.arcName || "";
    const base = arcName.replace(/(\.tar\.gz|\.tar\.bz2|\.tar\.xz|\.tar\.zst|\.tgz|\.tbz2|\.txz|\.tzst|\.zipx|\.zip|\.jar|\.war|\.ear|\.apk|\.aar|\.rar|\.7z|\.iso|\.cab|\.cpio|\.deb|\.rpm|\.zst|\.lz4|\.tar)$/i, "") || arcName;
    const home = await homeDir().catch(() => "");
    const defaultDir = `${home || "~"}Downloads/${base}_extracted`;
    const picked = await dialogOpen({
      directory: true,
      multiple: false,
      defaultPath: defaultDir,
      title: t("选择提取目录"),
    });
    if (!picked) return;
    const dir = String(picked);
    this.status(t("正在提取…"));
    try {
      const files = await invoke<string[]>("extract_archive_entry", { path: tmp, entryName: entry, targetDir: dir, isDir });
      this.status(t("已提取 {n} 个条目到 {dir}", { n: files.length, dir }));
    } catch (e) {
      this.status(String(e));
    }
  }

  // 远程归档文件解压到本地：extract=弹窗选目录，extract-here=下载目录，extract-named=下载目录/名称
  private async extractRemoteArchive(full: string, mode: string) {
    const name = full.split("/").pop() || full;
    const base = name.replace(/(\.tar\.gz|\.tar\.bz2|\.tar\.xz|\.tar\.zst|\.tgz|\.tbz2|\.txz|\.tzst|\.zipx|\.zip|\.jar|\.war|\.ear|\.apk|\.aar|\.rar|\.7z|\.iso|\.cab|\.cpio|\.deb|\.rpm|\.zst|\.lz4|\.tar)$/i, "") || name;
    const home = await homeDir().catch(() => "");
    const dl = `${home || "~"}Downloads`;
    let dir: string | null;
    if (mode === "extract") {
      const picked = await dialogOpen({
        directory: true,
        multiple: false,
        defaultPath: `${dl}/${base}_extracted`,
        title: t("选择解压目录"),
      });
      dir = picked ? String(picked) : null;
    } else if (mode === "extract-here") {
      dir = dl;
    } else {
      dir = `${dl}/${base}`;
    }
    if (!dir) return;
    this.status(t("正在解压…"));
    const tmp = await this.ensureArchiveTmp(full, name, Number(this.ctxNode?.dataset.size || 0));
    if (!tmp) return;
    try {
      const files = await invoke<string[]>("extract_archive_entry", { path: tmp, entryName: "", targetDir: dir, isDir: true });
      this.status(t("已解压 {n} 个条目到 {dir}", { n: files.length, dir }));
    } catch (e) {
      this.status(String(e));
    }
  }

  // 归档内"进入"视图：平铺当前虚拟目录，子目录箭头内联展开/收起，双击进入，文件双击打开
  private renderRemoteArcView() {
    const tree = this.q<HTMLElement>("#ftp-tree");
    if (!tree) return;
    tree.innerHTML = "";
    this.selectedNode = null;
    const av = this.arcView!;
    const children = findArchiveChildren(this.arcTree, av.dir);
    const frag = document.createDocumentFragment();
    for (const n of sortEntries(children, this.sort)) {
      if (!this.showHidden && n.name.startsWith(".")) continue;
      if (n.isDir) {
        const div = document.createElement("div");
        div.className = "ft-node ft-remote-item ft-dir ft-arc ft-vdir";
        div.dataset.tmp = av.tmp;
        div.dataset.kind = av.kind;
        div.dataset.arcName = av.arcName;
        div.dataset.remotePath = av.remotePath;
        div.dataset.entry = n.path;
        div.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size"></span><span class="ft-kind"></span><span class="ft-time"></span>`;
        // 箭头 = 内联展开/收起，双击 = 进入
        const box = document.createElement("div");
        box.className = "ft-children";
        box.style.display = "none";
        box.appendChild(this.renderRemoteArcNodes(n.children, 1, av));
        div.addEventListener("click", (e) => {
          this.selectNode(div);
          if ((e.target as HTMLElement).classList.contains("ft-arrow")) this.toggleRemoteVdir(div);
        });
        div.addEventListener("dblclick", () => void this.enterRemoteArcDir(div));
        frag.appendChild(div);
        frag.appendChild(box);
      } else {
        const div = document.createElement("div");
        div.className = "ft-node ft-remote-item ft-file ft-arc ft-vfile";
        div.dataset.tmp = av.tmp;
        div.dataset.kind = av.kind;
        div.dataset.arcName = av.arcName;
        div.dataset.remotePath = av.remotePath;
        div.dataset.entry = n.path;
        div.innerHTML = `<span class="ft-arrow ft-arrow-spacer"></span><span class="ft-ico ft-${extFor(n.name)}">${iconLabel(extFor(n.name))}</span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size">${fmtSize(n.size)}</span><span class="ft-kind">${escapeHtml(kindLabel(n.name))}</span><span class="ft-time"></span>`;
        div.addEventListener("click", () => this.selectNode(div));
        div.addEventListener("dblclick", () => this.openRemoteVFile(div));
        frag.appendChild(div);
      }
    }
    tree.appendChild(frag);
  }

  // 归档进入视图内的内联子树（箭头懒展开，缩进层级）
  private renderRemoteArcNodes(
    nodes: ArchiveNode[],
    depth: number,
    av: { tmp: string; kind: string; arcName: string; remotePath: string },
  ): HTMLElement {
    const ul = document.createElement("div");
    ul.className = "ft-children";
    for (const n of sortEntries(nodes, this.sort)) {
      if (!this.showHidden && n.name.startsWith(".")) continue;
      const div = document.createElement("div");
      if (n.isDir) {
        div.className = "ft-node ft-remote-item ft-dir ft-arc ft-vdir";
        div.dataset.tmp = av.tmp;
        div.dataset.kind = av.kind;
        div.dataset.arcName = av.arcName;
        div.dataset.remotePath = av.remotePath;
        div.dataset.entry = n.path;
        // 缩进由 .ft-children 嵌套提供（与普通树一致），不加 inline padding
        div.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size"></span><span class="ft-kind"></span><span class="ft-time"></span>`;
        const box = document.createElement("div");
        box.className = "ft-children";
        box.style.display = "none";
        box.appendChild(this.renderRemoteArcNodes(n.children, depth + 1, av));
        div.addEventListener("click", (e) => {
          this.selectNode(div);
          if ((e.target as HTMLElement).classList.contains("ft-arrow")) this.toggleRemoteVdir(div);
        });
        div.addEventListener("dblclick", () => void this.enterRemoteArcDir(div));
        ul.appendChild(div);
        ul.appendChild(box);
      } else {
        div.className = "ft-node ft-remote-item ft-file ft-arc ft-vfile";
        div.dataset.tmp = av.tmp;
        div.dataset.kind = av.kind;
        div.dataset.arcName = av.arcName;
        div.dataset.remotePath = av.remotePath;
        div.dataset.entry = n.path;
        div.innerHTML = `<span class="ft-arrow ft-arrow-spacer"></span><span class="ft-ico ft-${extFor(n.name)}">${iconLabel(extFor(n.name))}</span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size">${fmtSize(n.size)}</span><span class="ft-kind">${escapeHtml(kindLabel(n.name))}</span><span class="ft-time"></span>`;
        div.addEventListener("click", () => this.selectNode(div));
        div.addEventListener("dblclick", () => this.openRemoteVFile(div));
        ul.appendChild(div);
      }
    }
    return ul;
  }

  private toggleRemoteVdir(node: HTMLElement) {
    const box = node.nextElementSibling as HTMLElement | null;
    const open = box?.style.display === "none";
    if (box) box.style.display = open ? "" : "none";
    node.classList.toggle("ft-open", open);
    node.querySelector(".ft-arrow")!.textContent = open ? "▾" : "▸";
  }

  private openRemoteVFile(node: HTMLElement) {
    this.onOpenArchive(
      node.dataset.tmp!, node.dataset.kind!, node.dataset.entry!, node.dataset.arcName!,
      this.proto, this.id, node.dataset.remotePath!,
    );
  }

  // 下载归档到本地缓存（大文件先确认）；返回临时路径，失败返回 null
  private async ensureArchiveTmp(full: string, name: string, size: number): Promise<string | null> {
    if (!this.id) return null;
    if (!this.archiveCache.has(full) && size > ARCHIVE_BIG_BYTES) {
      const ok = await this.confirmModal(
        t("大文件提示"),
        t("归档较大（{size}），浏览/编辑需下载到本地，可能耗时较长，是否继续？", { size: fmtSize(size) }),
      );
      if (!ok) return null;
    }
    let tmp = this.archiveCache.get(full);
    if (!tmp) {
      this.status(t("下载 {name}…", { name }));
      try {
        const taskId = newTransferId();
        tmp = this.isSftp()
          ? await invoke<string>("sftp_download", { id: this.id, remotePath: full, taskId })
          : await invoke<string>("ftp_download", { id: this.id, remoteName: full, taskId });
      } catch (e) {
        this.status(t("下载失败: {e}", { e: String(e) }));
        return null;
      }
      this.archiveCache.set(full, tmp);
    }
    return tmp;
  }

  private async download(full: string) {
    if (!this.id) return;
    const name = full.split("/").pop() || full;
    this.status(t("下载 {name}…", { name }));
    try {
      const taskId = newTransferId();
      const tmp = this.isSftp()
        ? await invoke<string>("sftp_download", { id: this.id, remotePath: full, taskId })
        : await invoke<string>("ftp_download", { id: this.id, remoteName: full, taskId });
      this.status(t("已下载到临时文件"));
      this.onOpenRemote(tmp, this.proto, this.id, full);
    } catch (e) {
      this.status(t("下载失败: {e}", { e: String(e) }));
    }
  }

  // 下载远程文件为本地临时副本，并用系统默认应用打开（只读查看，改动不回传）
  private async openWithDefault(full: string) {
    if (!this.id || !full) return;
    const name = full.split("/").pop() || full;
    this.status(t("下载 {name}…", { name }));
    try {
      const taskId = newTransferId();
      const tmp = this.isSftp()
        ? await invoke<string>("sftp_download", { id: this.id, remotePath: full, taskId })
        : await invoke<string>("ftp_download", { id: this.id, remoteName: full, taskId });
      this.status(t("已用默认应用打开 {name}（临时副本，改动不会回传）", { name }));
      await openPath(tmp);
    } catch (e) {
      this.status(t("打开失败: {e}", { e: String(e) }));
    }
  }

  private async saveAs(full: string) {
    if (!this.id) return;
    const name = full.split("/").pop() || full;
    const target = await dialogSave({ defaultPath: name, title: "下载到本地" });
    if (!target) return;
    this.status(t("下载 {name} → 本地…", { name }));
    try {
      const taskId = newTransferId();
      if (this.isSftp()) {
        await invoke("sftp_save_as", { id: this.id, remotePath: full, localPath: target, taskId });
      } else {
        await invoke("ftp_save_as", { id: this.id, remoteName: full, localPath: target, taskId });
      }
      this.status(t("已保存到 {target}", { target }));
    } catch (e) {
      this.status(t("下载失败: {e}", { e: String(e) }));
    }
  }

  private async downloadDir(full: string) {
    if (!this.id) return;
    const name = full.split("/").filter(Boolean).pop() || "remote";
    const target = await dialogOpen({ directory: true, title: t("选择保存目录") });
    if (!target) return;
    const dir = Array.isArray(target) ? target[0] : target;
    this.status(t("下载目录 {name}…", { name }));
    try {
      const taskId = newTransferId();
      const files = this.isSftp()
        ? await invoke<number>("sftp_download_dir", { id: this.id, remotePath: full, localRoot: dir, taskId })
        : await invoke<number>("ftp_download_dir", { id: this.id, remotePath: full, localRoot: dir, taskId });
      this.status(t("已下载 {n} 个文件到 {dir}", { n: String(files), dir }));
      const it = this.transfers.get(taskId);
      if (it) it.meta.textContent = t("完成 {n} 项", { n: String(files) }) + " · " + formatBytes(it.total);
    } catch (e) {
      this.status(t("下载目录失败: {e}", { e: String(e) }));
    }
  }

  private async doRename() {
    if (!this.id || !this.selectedPath) {
      this.status(t("请先选择一个文件或目录"));
      return;
    }
    const oldPath = this.selectedPath;
    const base = oldPath.split("/").pop() || oldPath;
    const newName = await this.promptText("重命名", "新名称", base);
    if (!newName) return;
    if (newName === base) return;
    this.status(t("重命名 {base} → {newName}…", { base, newName }));
    try {
      if (this.isSftp()) {
        await invoke("sftp_rename", { id: this.id, oldPath, newName });
      } else {
        await invoke("ftp_rename", { id: this.id, oldName: base, newName });
      }
      this.status(t("重命名完成"));
      this.expanded.clear();
      await this.refresh();
    } catch (e) {
      this.status(t("重命名失败: {e}", { e: String(e) }));
    }
  }

  // 多选删除：确认 N 项后逐个删（单节点同样走此路径）
  private async delPaths(paths: string[]) {
    if (!paths.length || !this.id) return;
    const multi = paths.length > 1;
    const name = multi ? t("选中 {n} 项", { n: paths.length }) : (paths[0].split("/").filter(Boolean).pop() || paths[0]);
    const yes = await this.confirm(multi ? t("确定删除选中的 {n} 项？", { n: paths.length }) : `确定删除 ${name} 吗？`);
    if (!yes) return;
    this.status(multi ? t("删除 {n} 项…", { n: paths.length }) : t("删除 {name}…", { name }));
    try {
      for (const p of paths) {
        const nm = p.split("/").filter(Boolean).pop() || p;
        if (this.isSftp()) {
          await invoke("sftp_delete", { id: this.id, path: p, isDir: this.ctxIsDir });
        } else {
          await invoke("ftp_delete", { id: this.id, name: nm, isDir: this.ctxIsDir });
        }
        this.expanded.delete(p);
      }
      this.clearRemoteMulti();
      this.status(multi ? t("已删除 {n} 项", { n: paths.length }) : t("已删除"));
      await this.refresh();
    } catch (e) {
      this.status(t("删除失败: {e}", { e: String(e) }));
    }
  }

  private async uploadFiles() {
    if (!this.id) return;
    const picked = await dialogOpen({ multiple: true, title: t("选择要上传的文件") });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    this.status(t("上传 {n} 个文件…", { n: files.length }));
    try {
      if (this.isSftp()) {
        for (const f of files) {
          await invoke("sftp_upload", { id: this.id, localPath: f, remotePath: join(this.path, baseName(f)), taskId: newTransferId() });
        }
      } else {
        for (const f of files) {
          await invoke("ftp_upload", { id: this.id, localPath: f, taskId: newTransferId() });
        }
      }
      this.status(t("上传完成"));
      this.expanded.clear();
      await this.refresh();
    } catch (e) {
      this.status(t("上传失败: {e}", { e: String(e) }));
    }
  }

  private promptText(title: string, label: string, value = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:320px;">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <label class="acct-f">${escapeHtml(label)}<input id="pt-input" class="fs-input" value="${escapeHtml(value)}" autofocus/></label>
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
      });
    });
  }

  private confirm(msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:300px;">
        <div class="modal-title">确认</div>
        <div class="modal-body">${escapeHtml(msg)}</div>
        <div class="modal-actions">
          <button class="search-btn" id="cf-ok">确定</button>
          <button class="search-btn" id="cf-cancel">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const done = (v: boolean) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#cf-ok")!.addEventListener("click", () => done(true));
      mask.querySelector("#cf-cancel")!.addEventListener("click", () => done(false));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) done(false);
      });
    });
  }

  private async upload() {
    const local = this.getActivePath();
    if (!local) {
      this.status(t("请先打开一个本地文件再上传"));
      return;
    }
    if (!this.id) return;
    try {
      this.status(t("上传中…"));
      if (this.isSftp()) {
        await invoke("sftp_upload", { id: this.id, localPath: local, remotePath: join(this.path, baseName(local)), taskId: newTransferId() });
      } else {
        await invoke("ftp_upload", { id: this.id, localPath: local, taskId: newTransferId() });
      }
      this.status(t("上传完成"));
      await this.refresh();
    } catch (e) {
      this.status(t("上传失败: {e}", { e: String(e) }));
    }
  }

  private async mkdir() {
    if (!this.id) return;
    const name = await this.promptRemoteInput(t("新建文件夹"), t("文件夹名称"));
    if (!name) return;
    try {
      if (this.isSftp()) {
        const dir = this.ctxTargetDir();
        if (!dir) return;
        await invoke("sftp_mkdir", { id: this.id, path: join(dir, name) });
      } else {
        await invoke("ftp_mkdir", { id: this.id, name });
      }
      await this.refresh();
    } catch (e) {
      this.status(t("失败: {e}", { e: String(e) }));
    }
  }

  // 右键菜单：在当前目录新建文件
  private async ctxNewFile() {
    if (!this.id) return;
    const name = await this.promptRemoteInput(t("新建文件"), t("文件名"));
    if (!name) return;
    try {
      if (this.isSftp()) {
        const dir = this.ctxTargetDir();
        if (!dir) return;
        const full = join(dir, name);
        await invoke("sftp_create_file", { id: this.id, path: full });
        await this.refresh();
        this.download(full);
      } else {
        await invoke("ftp_create_file", { id: this.id, name });
        await this.refresh();
        this.download(name);
      }
    } catch (e) {
      this.status(t("失败: {e}", { e: String(e) }));
    }
  }

  // 右键菜单：在当前目录新建文件夹
  private ctxNewDir() {
    return this.mkdir();
  }

  // 右键新建的目标目录：SFTP 下右键点是目录 → 其内部；是文件 → 其所在目录；面板空白 → 当前目录
  private ctxTargetDir(): string | null {
    if (!this.selectedPath) return this.path;
    if (this.ctxIsDir) return this.selectedPath;
    const idx = this.selectedPath.lastIndexOf("/");
    return idx > 0 ? this.selectedPath.slice(0, idx) : "/";
  }

  // 右键菜单：预览归档文件内容（tar/tar.gz 列表 + 条目内容预览）
  // 右键菜单：浏览归档（tar/tar.gz/tar.bz2/zip），树形展开 + 条目以新 tab 打开
  // 远程树中归档节点：像文件夹一样展开（下载缓存 → archive_list → 虚拟子树）
  private async archiveExpand(elm: HTMLElement) {
    if (!this.id) return;
    const name = elm.dataset.name!;
    const full = elm.dataset.path || name;
    const arrow = elm.querySelector<HTMLElement>(".ft-arrow")!;
    const existing = elm.nextElementSibling;
    // 收起
    if (this.expanded.has(full)) {
      this.expanded.delete(full);
      elm.classList.remove("expanded");
      arrow.textContent = "▸";
      if (existing && existing.classList.contains("ft-children")) existing.remove();
      return;
    }
    // 下载缓存（大文件先确认）
    const tmp = await this.ensureArchiveTmp(full, name, Number(elm.dataset.size || 0));
    if (!tmp) return;
    let entries: ArchiveEntry[];
    try {
      entries = await invoke<ArchiveEntry[]>("archive_list", { path: tmp });
    } catch (e) {
      this.status(t("读取归档失败: {e}", { e: String(e) }));
      return;
    }
    this.expanded.add(full);
    elm.classList.add("expanded");
    arrow.textContent = "▾";
    const box = document.createElement("div");
    box.className = "ft-children";
    box.innerHTML = `<div class="ft-loading">${t("读取中…")}</div>`;
    elm.after(box);
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    this.renderArchiveRemote(buildArchiveTree(entries), frag, tmp, archiveKindOf(name), name, full);
    box.appendChild(frag);
  }

  // 渲染远程归档虚拟子树（目录：箭头展开/双击进入；文件：单击选中/双击打开）
  private renderArchiveRemote(
    nodes: ArchiveNode[],
    container: Node,
    tmp: string,
    kind: string,
    arcName: string,
    remotePath: string,
  ) {
    for (const n of sortEntries(nodes, this.sort)) {
      if (!this.showHidden && n.name.startsWith(".")) continue;
      const div = document.createElement("div");
      div.className = "ft-node ft-remote-item " + (n.isDir ? "ft-dir" : "ft-file") + " ft-arc";
      div.dataset.tmp = tmp;
      div.dataset.kind = kind;
      div.dataset.arcName = arcName;
      div.dataset.remotePath = remotePath;
      const arrow = n.isDir ? `<span class="ft-arrow">▸</span>` : `<span class="ft-arrow ft-arrow-spacer"></span>`;
      const ico = n.isDir ? "ft-dir-ico" : `ft-${extFor(n.name)}`;
      div.innerHTML = `${arrow}<span class="ft-ico ${ico}">${n.isDir ? "" : iconLabel(extFor(n.name))}</span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size">${n.isDir ? "" : fmtSize(n.size)}</span><span class="ft-kind">${n.isDir ? "" : escapeHtml(kindLabel(n.name))}</span><span class="ft-time"></span>`;
      if (n.isDir) {
        div.classList.add("ft-vdir");
        div.dataset.entry = n.path;
        const childBox = document.createElement("div");
        childBox.className = "ft-children";
        childBox.style.display = "none";
        div.addEventListener("click", (e) => {
          e.stopPropagation();
          this.selectNode(div);
          if (!(e.target as HTMLElement).classList.contains("ft-arrow")) return;
          const open = childBox.style.display === "none";
          childBox.style.display = open ? "" : "none";
          div.querySelector(".ft-arrow")!.textContent = open ? "▾" : "▸";
        });
        div.addEventListener("dblclick", () => void this.enterRemoteArcDir(div));
        container.appendChild(div);
        container.appendChild(childBox);
        this.renderArchiveRemote(n.children, childBox, tmp, kind, arcName, remotePath);
      } else {
        div.classList.add("ft-vfile");
        div.dataset.entry = n.path;
        div.addEventListener("click", (e) => {
          e.stopPropagation();
          this.selectNode(div);
        });
        div.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this.openRemoteVFile(div);
        });
        container.appendChild(div);
      }
    }
  }

  // 通用确认对话框
  private confirmModal(title: string, msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:360px;max-width:480px;">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body" style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(msg)}</div>
        <div class="modal-actions">
          <button class="search-btn" id="cfm-ok">${t("继续")}</button>
          <button class="search-btn" id="cfm-cancel">${t("取消")}</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const close = (v: boolean) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#cfm-ok")!.addEventListener("click", () => close(true));
      mask.querySelector("#cfm-cancel")!.addEventListener("click", () => close(false));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(false);
      });
    });
  }

  // 通用输入对话框
  private promptRemoteInput(title: string, placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:320px;">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <input id="ctx-name-input" class="fs-input" placeholder="${escapeHtml(placeholder)}" autofocus spellcheck="false"/>
        </div>
        <div class="modal-actions">
          <button class="search-btn" id="ctx-name-ok">${t("创建")}</button>
          <button class="search-btn" id="ctx-name-cancel">${t("取消")}</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector("#ctx-name-input") as HTMLInputElement;
      const close = (v: string | null) => {
        mask.remove();
        resolve(v);
      };
      const ok = () => close(input.value.trim() || null);
      mask.querySelector("#ctx-name-ok")!.addEventListener("click", ok);
      mask.querySelector("#ctx-name-cancel")!.addEventListener("click", () => close(null));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(null);
      });
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok();
        if (e.key === "Escape") close(null);
      });
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// 不可展开的二进制扩展名（可展开归档走 archive.ts 的 isArchiveFile）
const BINARY_RE = /\.(gz|bz2|xz|zst|rar|7z|z|iso|dmg|pkg|app|exe|msi|bin|dll|dylib|so|o|a|class|jar|war|png|jpe?g|gif|webp|bmp|ico|svgz|pdf|mov|mp4|mkv|avi|webm|mp3|wav|flac|ogg|m4a|aac|db|sqlite|sqlite3|keystore|jks)$/i;
function isBinaryName(name: string): boolean {
  return BINARY_RE.test(name);
}
