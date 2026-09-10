import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FileEntry } from "./types";
import { isArchiveFile, archiveKindOf, buildArchiveTree, findArchiveChildren, type ArchiveEntry, type ArchiveNode } from "./archive";
import { extFor, iconLabel } from "./fileicons";
import { t } from "./i18n";
import { sortEntries, loadTreeSort, createSortBar, fmtTime, kindLabel, type TreeSortState } from "./tree-sort";

const cache = new Map<string, FileEntry[]>();

async function list(path: string): Promise<FileEntry[]> {
  let e = cache.get(path);
  if (!e) {
    e = await invoke<FileEntry[]>("list_dir", { path }).catch(() => []);
    cache.set(path, e);
  }
  return e;
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 归档内虚拟导航视图
interface ArcView {
  arcPath: string;
  kind: string;
  arcName: string;
  dir: string; // 归档内当前目录（"" = 根）
}

export class FileTree {
  private el: HTMLElement;
  private curDir = "";
  private arcView: ArcView | null = null;
  private arcTree: ArchiveNode[] = [];
  private arcTreePath = "";
  private selected: HTMLElement | null = null;
  // 展开状态记录（refreshAll/render 重绘后恢复，避免操作后树被收起）
  private expandedDirs = new Set<string>();   // 物理目录 path
  private expandedArcs = new Set<string>();   // 归档文件 arcPath（树内展开）
  private expandedVdirs = new Set<string>();  // 归档内虚拟目录 arcPath + "!/" + entry
  private onOpen: (path: string) => void;
  private onOpenArchive: (archivePath: string, kind: string, entry: string, archiveName: string) => void;
  private showHidden = false;
  private ctx: HTMLElement;
  private ctxPath: string | null = null;
  private ctxIsDir = false;
  private ctxArcNode: HTMLElement | null = null;
  private ctxNode: HTMLElement | null = null;
  private sort: TreeSortState = loadTreeSort();

  constructor(
    el: HTMLElement,
    onOpen: (path: string) => void,
    onOpenArchive: (archivePath: string, kind: string, entry: string, archiveName: string) => void,
    showHidden = false,
  ) {
    this.el = el;
    this.onOpen = onOpen;
    this.onOpenArchive = onOpenArchive;
    this.showHidden = showHidden;
    // 排序栏：位于路径栏与树之间（Finder 列头式）
    this.ensureSortBar();
    el.addEventListener("click", (e) => this.onClick(e));
    el.addEventListener("dblclick", (e) => this.onDblClick(e));
    // 右键菜单
    this.ctx = document.createElement("div");
    this.ctx.className = "ctx-menu hidden";
    this.ctx.innerHTML = `
      <div class="ctx-item" data-act="refresh">${t("刷新")}</div>
      <div class="ctx-item hidden" data-arc="1" data-act="arc-open">${t("打开")}</div>
      <div class="ctx-item hidden" data-arc="1" data-act="arc-copypath">${t("复制路径")}</div>
      <div class="ctx-item hidden" data-arc="1" data-act="arc-refresh">${t("刷新归档")}</div>
      <div class="ctx-item hidden" data-arc="1" data-act="arc-extract">${t("提取到本地…")}</div>
      <div class="ctx-sep hidden" data-arc="1"></div>
      <div class="ctx-item" data-act="open">${t("打开")}</div>
      <div class="ctx-item" data-act="extract">${t("解压文件…")}</div>
      <div class="ctx-item" data-act="extract-here">${t("解压到当前文件夹")}</div>
      <div class="ctx-item" data-act="extract-named">${t("解压到 ")}<span data-name-label></span>\\</div>
      <div class="ctx-item" data-act="newfile">${t("新建文件")}</div>
      <div class="ctx-item" data-act="newdir">${t("新建文件夹")}</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-act="rename">${t("重命名")}</div>
      <div class="ctx-item ctx-danger" data-act="del">${t("删除")}</div>
      <div class="ctx-item" data-act="copypath">${t("复制路径")}</div>
      <div class="ctx-item" data-act="terminal">${t("在终端打开")}</div>`;
    document.body.appendChild(this.ctx);
    el.addEventListener("contextmenu", (e) => this.onCtx(e));
    this.ctx.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        this.ctx.classList.add("hidden");
        void this.ctxAction(item.dataset.act!);
      });
    });
    document.addEventListener("click", (e) => {
      if (!this.ctx.contains(e.target as Node)) this.ctx.classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.ctx.classList.add("hidden");
    });
  }

  // 显示隐藏文件开关（由 app 层调用并持久化）
  setShowHidden(v: boolean) {
    this.showHidden = v;
    if (this.curDir || this.arcView) void this.render("");
  }

  // 重建排序栏（点击排序后刷新高亮/箭头）
  private ensureSortBar() {
    const old = this.el.previousElementSibling;
    if (old && old.classList.contains("ft-sortbar")) old.remove();
    const bar = createSortBar(this.sort, (next) => {
      this.sort = next;
      this.ensureSortBar();
      if (this.curDir || this.arcView) void this.render("");
    });
    if (this.el.parentElement) this.el.parentElement.insertBefore(bar, this.el);
  }

  async showRoot(root: string) {
    if (!root || typeof root !== "string") {
      this.curDir = "";
      this.arcView = null;
      this.el.innerHTML = "";
      return;
    }
    this.curDir = root;
    this.arcView = null;
    await this.render(dirName(root));
  }

  wipe() {
    this.el.innerHTML = "";
  }

  // 当前目录（供快速打开等外部使用）
  getCurDir(): string {
    return this.curDir;
  }

  private async render(_relative: string) {
    this.el.innerHTML = "";
    this.selected = null;
    this.renderPath();
    if (this.arcView) {
      this.renderArcView();
      return;
    }
    const dir = this.curDir;
    const children = await list(dir);
    const frag = document.createDocumentFragment();
    frag.appendChild(this.renderChildren(sortEntries(children, this.sort), dir));
    this.el.appendChild(frag);
    // 重绘后恢复此前展开的目录/归档（zip 展开后再恢复其内虚拟目录）
    const nodes = this.el.querySelectorAll<HTMLElement>(".ft-node");
    for (const node of nodes) {
      if (node.classList.contains("ft-dir") && !node.classList.contains("ft-vdir")) {
        const p = node.dataset.path;
        if (p && this.expandedDirs.has(p) && !node.classList.contains("ft-open")) {
          await this.toggleDir(node, p);
        }
      } else if (node.dataset.arcRoot === "1") {
        const p = node.dataset.arcPath!;
        if (this.expandedArcs.has(p) && !node.classList.contains("ft-open")) {
          await this.toggleArchive(node);
          const box = node.nextElementSibling as HTMLElement | null;
          if (box) this.restoreVdirs(box);
        }
      }
    }
  }

  // 恢复 zip 树内展开的虚拟目录展开状态
  private restoreVdirs(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>(".ft-vdir").forEach((nd) => {
      const key = `${nd.dataset.arcPath}!/${nd.dataset.entry}`;
      if (this.expandedVdirs.has(key) && !nd.classList.contains("ft-open")) this.toggleVdir(nd);
    });
  }

  // 面包屑路径栏（Finder 式进入导航）
  private renderPath() {
    const bar = document.getElementById("ft-path");
    if (!bar) return;
    // 路径栏右侧的操作按钮（刷新 / 显示隐藏文件），随路径栏 flex 垂直居中
    const btns =
      `<button id="sb-refresh-local" class="sb-hidden sb-refresh" title="${t("刷新")}">` +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' +
      "</button>" +
      `<button id="sb-hidden-local" class="sb-hidden${this.showHidden ? " on" : ""}" title="${t(this.showHidden ? "隐藏隐藏文件" : "显示隐藏文件")}">` +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
      "</button>";
    if (this.arcView) {
      const arc = this.arcView;
      const segs = arc.dir ? arc.dir.split("/") : [];
      const crumbs: Array<{ label: string; dir: string; exit?: boolean }> = [
        { label: "← 返回文件树", dir: "", exit: true },
        { label: arc.arcName, dir: "" },
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
    } else {
      const parts = this.curDir.split("/").filter(Boolean);
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
    }
    bar.querySelectorAll<HTMLElement>(".ft-crumb").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.dataset.exit === "1") {
          // 退出归档进入视图，返回文件树当前目录
          this.arcView = null;
          void this.render(this.curDir);
          return;
        }
        if (el.dataset.kind === "arc") {
          if (this.arcView) {
            this.arcView.dir = el.dataset.dir!;
            void this.render(el.dataset.dir!);
          }
        } else {
          this.curDir = el.dataset.path!;
          this.arcView = null;
          void this.render(el.dataset.path!);
        }
      });
    });
  }

  private renderChildren(children: FileEntry[], _dir: string): HTMLElement {
    const ul = document.createElement("div");
    ul.className = "ft-children";
    for (const c of children) {
      if (!this.showHidden && isHiddenName(c.name)) continue;
      if (c.is_dir) {
        const node = document.createElement("div");
        node.className = "ft-node ft-dir";
        node.dataset.path = c.path;
        node.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(c.name)}</span><span class="ft-size"></span><span class="ft-kind"></span><span class="ft-time">${fmtTime(c.modified)}</span>`;
        ul.appendChild(node);
      } else if (isArchiveFile(c.name)) {
        // 归档文件：作为虚拟文件夹，箭头展开内部结构；双击进入
        const node = document.createElement("div");
        node.className = "ft-node ft-file ft-archive";
        node.dataset.path = c.path;
        node.dataset.arcPath = c.path;
        node.dataset.kind = archiveKindOf(c.name);
        node.dataset.arcName = c.name;
        node.dataset.arcRoot = "1";
        node.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-${extFor(c.name)}"></span><span class="ft-name">${escapeHtml(c.name)}</span><span class="ft-size">${fmtSize(c.size)}</span><span class="ft-kind">${escapeHtml(kindLabel(c.name))}</span><span class="ft-time">${fmtTime(c.modified)}</span>`;
        ul.appendChild(node);
      } else {
        const node = document.createElement("div");
        node.className = "ft-node ft-file";
        node.dataset.path = c.path;
        node.innerHTML = `<span class="ft-arrow ft-arrow-spacer"></span><span class="ft-ico ft-${extFor(c.name)}">${iconLabel(extFor(c.name))}</span><span class="ft-name">${escapeHtml(c.name)}</span><span class="ft-size">${fmtSize(c.size)}</span><span class="ft-kind">${escapeHtml(kindLabel(c.name))}</span><span class="ft-time">${fmtTime(c.modified)}</span>`;
        ul.appendChild(node);
      }
    }
    return ul;
  }

  // 渲染归档虚拟子树（树内展开模式，子目录折叠，点击箭头时 DOM 内切换显示）
  private renderArchiveNodes(
    nodes: ArchiveNode[],
    depth: number,
    arcPath: string,
    kind: string,
    arcName: string,
  ): HTMLElement {
    const ul = document.createElement("div");
    ul.className = "ft-children";
    for (const n of sortEntries(nodes, this.sort)) {
      if (!this.showHidden && isHiddenName(n.name)) continue;
      if (n.isDir) {
        const node = document.createElement("div");
        node.className = "ft-node ft-dir ft-vdir";
        node.dataset.arcPath = arcPath;
        node.dataset.kind = kind;
        node.dataset.arcName = arcName;
        node.dataset.entry = n.path;
        // 缩进由 .ft-children 嵌套提供（与本地/远程普通树一致），不加 inline padding
        node.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size"></span><span class="ft-kind"></span><span class="ft-time"></span>`;
        const box = document.createElement("div");
        box.className = "ft-children";
        box.style.display = "none";
        box.appendChild(this.renderArchiveNodes(n.children, depth + 1, arcPath, kind, arcName));
        ul.appendChild(node);
        ul.appendChild(box);
      } else {
        const node = document.createElement("div");
        node.className = "ft-node ft-file ft-vfile";
        node.dataset.vfile = "1";
        node.dataset.arcPath = arcPath;
        node.dataset.kind = kind;
        node.dataset.entry = n.path;
        node.dataset.arcName = arcName;
        node.innerHTML = `<span class="ft-arrow ft-arrow-spacer"></span><span class="ft-ico ft-${extFor(n.name)}">${iconLabel(extFor(n.name))}</span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size">${fmtSize(n.size)}</span><span class="ft-kind">${escapeHtml(kindLabel(n.name))}</span><span class="ft-time"></span>`;
        ul.appendChild(node);
      }
    }
    return ul;
  }

  // 归档内"进入"视图：平铺当前虚拟目录，子目录可再进入（单击箭头/双击），文件双击打开
  private renderArcView() {
    const arc = this.arcView!;
    const children = findArchiveChildren(this.arcTree, arc.dir);
    const ul = document.createElement("div");
    ul.className = "ft-children";
    for (const n of sortEntries(children, this.sort)) {
      if (!this.showHidden && isHiddenName(n.name)) continue;
      if (n.isDir) {
        const node = document.createElement("div");
        node.className = "ft-node ft-dir ft-vdir";
        node.dataset.arcPath = arc.arcPath;
        node.dataset.kind = arc.kind;
        node.dataset.arcName = arc.arcName;
        node.dataset.entry = n.path;
        node.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size"></span><span class="ft-kind"></span><span class="ft-time"></span>`;
        // 箭头 = 内联展开/收起（Finder 语义），双击 = 进入
        const box = document.createElement("div");
        box.className = "ft-children";
        box.style.display = "none";
        box.appendChild(this.renderArchiveNodes(n.children, 1, arc.arcPath, arc.kind, arc.arcName));
        ul.appendChild(node);
        ul.appendChild(box);
      } else {
        const node = document.createElement("div");
        node.className = "ft-node ft-file ft-vfile";
        node.dataset.vfile = "1";
        node.dataset.arcPath = arc.arcPath;
        node.dataset.kind = arc.kind;
        node.dataset.entry = n.path;
        node.dataset.arcName = arc.arcName;
        node.innerHTML = `<span class="ft-arrow ft-arrow-spacer"></span><span class="ft-ico ft-${extFor(n.name)}">${iconLabel(extFor(n.name))}</span><span class="ft-name">${escapeHtml(n.name)}</span><span class="ft-size">${fmtSize(n.size)}</span><span class="ft-kind">${escapeHtml(kindLabel(n.name))}</span><span class="ft-time"></span>`;
        ul.appendChild(node);
      }
    }
    this.el.appendChild(ul);
  }

  // ---------- Finder 交互：单击箭头=展开/收起；单击名称=选中；双击=进入/打开 ----------

  private async onClick(e: MouseEvent) {
    const node = (e.target as HTMLElement).closest<HTMLElement>(".ft-node");
    if (!node) return;
    const isArrow = (e.target as HTMLElement).classList.contains("ft-arrow");
    this.select(node);
    if (this.arcView) {
      // 进入视图模式：虚拟目录单击箭头 = 内联展开/收起（Finder 语义），双击 = 进入
      if (node.classList.contains("ft-vdir") && isArrow) {
        this.toggleVdir(node);
      }
      return;
    }
    const path = node.dataset.path;
    if (node.dataset.arcRoot === "1") {
      if (isArrow) await this.toggleArchive(node);
      return;
    }
    if (node.classList.contains("ft-vdir")) {
      if (isArrow) this.toggleVdir(node);
      return;
    }
    if (node.dataset.vfile === "1") return;
    if (!path) return;
    if (node.classList.contains("ft-dir")) {
      if (isArrow) await this.toggleDir(node, path);
      return;
    }
    // 普通文件：仅选中（双击打开）
  }

  private onDblClick(e: MouseEvent) {
    const node = (e.target as HTMLElement).closest<HTMLElement>(".ft-node");
    if (!node) return;
    if (this.arcView) {
      if (node.classList.contains("ft-vdir")) {
        this.enterArchiveDir(node);
      } else if (node.dataset.vfile === "1") {
        this.openVFile(node);
      }
      return;
    }
    if (node.dataset.arcRoot === "1") {
      void this.enterArchiveRoot(node);
      return;
    }
    if (node.classList.contains("ft-vdir")) {
      this.enterArchiveDir(node);
      return;
    }
    if (node.dataset.vfile === "1") {
      this.openVFile(node);
      return;
    }
    const path = node.dataset.path;
    if (!path) return;
    if (node.classList.contains("ft-dir")) {
      this.enterDir(path);
      return;
    }
    this.onOpen(path);
  }

  private select(node: HTMLElement) {
    if (this.selected && this.selected !== node) this.selected.classList.remove("ft-selected");
    this.selected = node;
    node.classList.add("ft-selected");
  }

  // 双击目录：进入（Finder）——树根切换为该目录，面包屑可返回
  private enterDir(path: string) {
    this.curDir = path;
    this.arcView = null;
    void this.render(path);
  }

  private openVFile(node: HTMLElement) {
    this.onOpenArchive(node.dataset.arcPath!, node.dataset.kind!, node.dataset.entry!, node.dataset.arcName!);
  }

  // 双击归档文件：进入归档根视图
  private async enterArchiveRoot(node: HTMLElement) {
    const arc = { arcPath: node.dataset.arcPath!, kind: node.dataset.kind!, arcName: node.dataset.arcName!, dir: "" };
    if (!(await this.loadArcTree(arc.arcPath))) return;
    this.arcView = arc;
    void this.render("");
  }

  // 双击/箭头进入归档内虚拟目录
  private enterArchiveDir(node: HTMLElement) {
    const arc = this.arcView;
    if (!arc) {
      // 树内展开模式下双击 vdir：进入该虚拟目录
      const a: ArcView = {
        arcPath: node.dataset.arcPath!,
        kind: node.dataset.kind!,
        arcName: node.dataset.arcName!,
        dir: node.dataset.entry || "",
      };
      void (async () => {
        if (!(await this.loadArcTree(a.arcPath))) return;
        this.arcView = a;
        void this.render("");
      })();
      return;
    }
    arc.dir = node.dataset.entry || "";
    void this.render("");
  }

  private async loadArcTree(arcPath: string): Promise<boolean> {
    if (this.arcTreePath === arcPath && this.arcTree.length) return true;
    try {
      const entries = await invoke<ArchiveEntry[]>("archive_list", { path: arcPath });
      this.arcTree = buildArchiveTree(entries);
      this.arcTreePath = arcPath;
      return true;
    } catch (e) {
      console.error("[0xEdit] archive_list 失败:", e);
      this.toast(String(e));
      return false;
    }
  }

  // 展开/收起物理目录（懒加载子树）
  private async toggleDir(node: HTMLElement, path: string) {
    const collapsed = node.classList.contains("ft-open");
    if (collapsed) {
      node.classList.remove("ft-open");
      node.querySelector(".ft-arrow")!.textContent = "▸";
      this.expandedDirs.delete(path);
      const children = node.nextElementSibling;
      if (children?.classList.contains("ft-children")) {
        (children as HTMLElement).style.display = "none";
      }
      return;
    }
    node.classList.add("ft-open");
    node.querySelector(".ft-arrow")!.textContent = "▾";
    let children = node.nextElementSibling as HTMLElement | null;
    if (!children || !children.classList.contains("ft-children")) {
      children = this.renderChildren(sortEntries(await list(path), this.sort), path);
      node.after(children);
    }
    children.style.display = "";
    this.expandedDirs.add(path);
  }

  // 归档内虚拟目录：显示/隐藏已渲染的子节点（树内展开模式）
  private toggleVdir(node: HTMLElement) {
    const box = node.nextElementSibling as HTMLElement | null;
    const open = box?.style.display === "none";
    if (box) box.style.display = open ? "" : "none";
    node.classList.toggle("ft-open", open);
    node.querySelector(".ft-arrow")!.textContent = open ? "▾" : "▸";
    const key = `${node.dataset.arcPath}!/${node.dataset.entry}`;
    if (open) this.expandedVdirs.add(key);
    else this.expandedVdirs.delete(key);
  }

  // 归档节点展开：懒加载条目列表 → 渲染虚拟子树；解析失败回退为普通文件打开
  private async toggleArchive(node: HTMLElement) {
    const path = node.dataset.path!;
    const isOpen = node.classList.contains("ft-open");
    if (isOpen) {
      node.classList.remove("ft-open");
      node.querySelector(".ft-arrow")!.textContent = "▸";
      this.expandedArcs.delete(path);
      const children = node.nextElementSibling as HTMLElement | null;
      if (children && children.classList.contains("ft-children")) children.style.display = "none";
      return;
    }
    // 加载中：忽略重复/快速双击，避免展开与收起竞态
    if (node.dataset.arcLoading === "1") return;
    node.dataset.arcLoading = "1";
    node.classList.add("ft-open");
    node.querySelector(".ft-arrow")!.textContent = "▾";
    try {
      let box = node.nextElementSibling as HTMLElement | null;
      if (!box || !box.classList.contains("ft-children") || box.dataset.archived !== "1") {
        let entries: ArchiveEntry[];
        try {
          entries = await invoke<ArchiveEntry[]>("archive_list", { path });
        } catch (e) {
          // 非归档/损坏：当作普通文件打开（二进制走 hex）
          console.error("[0xEdit] archive_list 失败，回退为普通文件打开:", e);
          node.classList.remove("ft-open");
          node.querySelector(".ft-arrow")!.textContent = "▸";
          this.onOpen(path);
          return;
        }
        box = document.createElement("div");
        box.className = "ft-children";
        box.dataset.archived = "1";
        box.appendChild(this.renderArchiveNodes(buildArchiveTree(entries), 0, path, node.dataset.kind!, node.dataset.arcName!));
        node.after(box);
      }
      box.style.display = "";
      this.expandedArcs.add(path);
    } finally {
      delete node.dataset.arcLoading;
    }
  }

  // ---------- 本地右键菜单 ----------

  private onCtx(e: MouseEvent) {
    const node = (e.target as HTMLElement).closest<HTMLElement>(".ft-node");
    if (!node) {
      // 空白处：物理目录提供「新建文件/新建文件夹/在终端打开」（Finder 语义）；归档视图只读不弹
      if (this.arcView) return;
      e.preventDefault();
      this.ctxArcNode = null;
      this.ctxNode = null;
      this.ctxPath = this.curDir || null;
      this.ctxIsDir = true;
      this.ctx.querySelectorAll<HTMLElement>("[data-act]").forEach((it) => {
        const arc = it.dataset.arc === "1";
        const keep = ["refresh", "newfile", "newdir", "terminal"].includes(it.dataset.act!);
        it.classList.toggle("hidden", arc || !keep);
      });
      this.ctx.querySelectorAll<HTMLElement>(".ctx-sep").forEach((sep) => sep.classList.add("hidden"));
      this.ctx.style.left = `${e.clientX}px`;
      this.ctx.style.top = `${e.clientY}px`;
      this.ctx.classList.remove("hidden");
      return;
    }
    e.preventDefault();
    // 归档虚拟节点（目录树/文件）无物理路径，弹归档专用菜单
    const isArc = node.dataset.vfile === "1" || node.classList.contains("ft-vdir");
    this.ctxArcNode = isArc ? node : null;
    this.ctxIsDir = node.classList.contains("ft-dir");
    this.ctx.querySelectorAll<HTMLElement>("[data-act]").forEach((it) => {
      const arc = it.dataset.arc === "1";
      it.classList.toggle("hidden", isArc ? !arc : arc || it.dataset.act === "refresh");
    });
    this.ctx.style.left = `${e.clientX}px`;
    this.ctx.style.top = `${e.clientY}px`;
    this.ctx.classList.remove("hidden");
    if (isArc) return;
    this.ctxNode = node;
    this.ctxPath = node.dataset.path || null;
    // 「新建」仅对目录生效
    (this.ctx.querySelector('[data-act="newfile"]') as HTMLElement).style.display = this.ctxIsDir ? "" : "none";
    (this.ctx.querySelector('[data-act="newdir"]') as HTMLElement).style.display = this.ctxIsDir ? "" : "none";
    // 归档解压/测试组仅对归档文件生效（WinRAR 风格）
    const nm = this.ctxPath ? (this.ctxPath.split("/").pop() || this.ctxPath.split("\\").pop() || "") : "";
    const isArcFile = isArchiveFile(nm);
    for (const a of ["extract", "extract-here", "extract-named"]) {
      (this.ctx.querySelector(`[data-act="${a}"]`) as HTMLElement).style.display = isArcFile ? "" : "none";
    }
    if (isArcFile) {
      const base = nm.replace(/(\.tar\.gz|\.tar\.bz2|\.tar\.xz|\.tar\.zst|\.tgz|\.tbz2|\.txz|\.tzst|\.zipx|\.zip|\.jar|\.war|\.ear|\.apk|\.aar|\.rar|\.7z|\.iso|\.cab|\.cpio|\.deb|\.rpm|\.zst|\.lz4|\.tar)$/i, "") || nm;
      (this.ctx.querySelector('[data-name-label]') as HTMLElement).textContent = base;
    }
  }

  private async ctxAction(act: string) {
    // 归档虚拟节点动作
    if (act.startsWith("arc-")) {
      const node = this.ctxArcNode;
      if (!node) return;
      if (act === "arc-open") {
        // 目录进入 / 文件打开，与双击一致（兼容进入视图与树内展开两种模式）
        if (node.classList.contains("ft-dir")) this.enterArchiveDir(node);
        else this.openVFile(node);
        return;
      }
      if (act === "arc-copypath") {
        const p = `${node.dataset.arcName}!/${node.dataset.entry}`;
        try {
          await navigator.clipboard.writeText(p);
          this.toast(t("已复制路径"));
        } catch {
          this.toast(t("复制失败"));
        }
        return;
      }
      if (act === "arc-refresh") {
        const arcPath = node.dataset.arcPath!;
        this.arcTreePath = "";
        this.arcTree = [];
        if (!(await this.loadArcTree(arcPath))) return;
        void this.render("");
        this.toast(t("归档已刷新"));
        return;
      }
      if (act === "arc-extract") {
        await this.extractEntry(node);
        return;
      }
      return;
    }
    if (act === "refresh") {
      this.refreshAll();
      this.toast(t("已刷新"));
      return;
    }
    if (!this.ctxPath) return;
    const path = this.ctxPath;
    const nm = path.split("/").pop() || path;
    if (act === "open") {
      // 与双击一致：归档文件进入视图 / 目录进入 / 文件打开
      if (isArchiveFile(nm) && this.ctxNode) {
        void this.enterArchiveRoot(this.ctxNode);
      } else if (this.ctxIsDir) {
        this.enterDir(path);
      } else {
        this.onOpen(path);
      }
      return;
    }
    const base = nm.replace(/(\.tar\.gz|\.tar\.bz2|\.tar\.xz|\.tar\.zst|\.tgz|\.tbz2|\.txz|\.tzst|\.zipx|\.zip|\.jar|\.war|\.ear|\.apk|\.aar|\.rar|\.7z|\.iso|\.cab|\.cpio|\.deb|\.rpm|\.zst|\.lz4|\.tar)$/i, "") || nm;
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const parent = idx >= 0 ? path.slice(0, idx) : ".";
    if (act === "extract") {
      // 解压文件…：目录选择器选目标目录
      const dir = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: `${parent}/${base}_extracted`,
        title: t("选择解压目录"),
      });
      if (!dir) return;
      await this.extractToDir(path, String(dir));
      return;
    }
    if (act === "extract-here") {
      // 解压到当前文件夹（归档所在目录）
      await this.extractToDir(path, parent);
      return;
    }
    if (act === "extract-named") {
      // 解压到 名称\（归档所在目录下的同名文件夹）
      await this.extractToDir(path, `${parent}/${base}`);
      return;
    }
    if (act === "copypath") {
      try {
        await navigator.clipboard.writeText(path);
        this.toast(t("已复制路径"));
      } catch {
        this.toast(t("复制失败"));
      }
      return;
    }
    if (act === "terminal") {
      const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const dir = this.ctxIsDir ? path : path.slice(0, idx + 1) || path;
      void invoke("open_terminal", { dir }).catch((err) => this.toast(String(err)));
      return;
    }
    if (act === "newfile" || act === "newdir") {
      const name = await this.promptModal(t(act === "newfile" ? "新建文件" : "新建文件夹"), "");
      if (!name) return;
      const ok = await invoke<boolean>(act === "newfile" ? "create_local_file" : "create_local_dir", { dir: path, name })
        .then(() => true)
        .catch((err) => {
          this.toast(String(err));
          return false;
        });
      if (!ok) return;
      this.toast(t("已创建 {name}", { name }));
      this.refreshAll();
      return;
    }
    if (act === "rename") {
      const base = path.split("/").pop() || path;
      const name = await this.promptModal(t("重命名"), base);
      if (!name || name === base) return;
      const ok = await invoke<boolean>("rename_local", { oldPath: path, newName: name })
        .then(() => true)
        .catch((err) => {
          this.toast(String(err));
          return false;
        });
      if (!ok) return;
      this.refreshAll();
      return;
    }
    if (act === "del") {
      const base = path.split("/").pop() || path;
      const yes = await this.confirmModal(
        t("删除"),
        this.ctxIsDir
          ? t("确定删除目录 {name} 及其全部内容？", { name: base })
          : t("确定删除文件 {name}？", { name: base }),
      );
      if (!yes) return;
      const ok = await invoke<boolean>("delete_local", { path, isDir: this.ctxIsDir })
        .then(() => true)
        .catch((err) => {
          this.toast(String(err));
          return false;
        });
      if (!ok) return;
      this.toast(t("已删除 {name}", { name: base }));
      this.refreshAll();
    }
  }

  private refreshAll() {
    cache.clear();
    if (this.curDir || this.arcView) void this.render("");
  }

  // 归档整体解压到指定目录（rar/7z 等外部格式同样支持）
  private async extractToDir(arcPath: string, dir: string) {
    this.toast(t("正在解压…"));
    try {
      const files = await invoke<string[]>("extract_archive_entry", { path: arcPath, entryName: "", targetDir: dir, isDir: true });
      this.toast(t("已解压 {n} 个条目到 {dir}", { n: files.length, dir }));
      this.refreshAll();
    } catch (e) {
      this.toast(String(e));
    }
  }

  // 提取归档内条目到本地目录（zip/tar 可编辑回写格式与 rar/7z 只读格式均支持）
  private async extractEntry(node: HTMLElement) {
    const arcPath = node.dataset.arcPath!;
    const entry = node.dataset.entry!;
    const isDir = node.classList.contains("ft-dir");
    const arcName = node.dataset.arcName || "";
    const base = arcName.replace(/(\.tar\.gz|\.tar\.bz2|\.tar\.xz|\.tar\.zst|\.tgz|\.tbz2|\.txz|\.tzst|\.zipx|\.zip|\.jar|\.war|\.ear|\.apk|\.aar|\.rar|\.7z|\.iso|\.cab|\.cpio|\.deb|\.rpm|\.zst|\.lz4|\.tar)$/i, "") || arcName;
    const idx = Math.max(arcPath.lastIndexOf("/"), arcPath.lastIndexOf("\\"));
    const parent = idx >= 0 ? arcPath.slice(0, idx) : ".";
    const dir = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: `${parent}/${base}_extracted`,
      title: t("选择提取目录"),
    });
    if (!dir) return;
    this.toast(t("正在提取…"));
    try {
      const files = await invoke<string[]>("extract_archive_entry", { path: arcPath, entryName: entry, targetDir: dir, isDir });
      this.toast(t("已提取 {n} 个条目到 {dir}", { n: files.length, dir }));
      this.refreshAll();
    } catch (e) {
      this.toast(String(e));
    }
  }

  // 外部刷新（如 Markdown 图片落盘后刷新树）
  refresh() {
    this.refreshAll();
  }

  private promptModal(title: string, value: string): Promise<string | null> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:320px;">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <input id="ft-name-input" class="fs-input" value="${escapeHtml(value)}" autofocus spellcheck="false"/>
        </div>
        <div class="modal-actions">
          <button class="search-btn" id="ft-name-ok">${t("确定")}</button>
          <button class="search-btn" id="ft-name-cancel">${t("取消")}</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector("#ft-name-input") as HTMLInputElement;
      const close = (v: string | null) => {
        mask.remove();
        resolve(v);
      };
      const ok = () => close(input.value.trim() || null);
      mask.querySelector("#ft-name-ok")!.addEventListener("click", ok);
      mask.querySelector("#ft-name-cancel")!.addEventListener("click", () => close(null));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(null);
      });
      input.focus();
      input.select();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok();
        if (e.key === "Escape") close(null);
      });
    });
  }

  private confirmModal(title: string, msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `<div class="modal" style="min-width:360px;max-width:480px;">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body" style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(msg)}</div>
        <div class="modal-actions">
          <button class="search-btn" id="ft-cfm-ok">${t("删除")}</button>
          <button class="search-btn" id="ft-cfm-cancel">${t("取消")}</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const close = (v: boolean) => {
        mask.remove();
        resolve(v);
      };
      mask.querySelector("#ft-cfm-ok")!.addEventListener("click", () => close(true));
      mask.querySelector("#ft-cfm-cancel")!.addEventListener("click", () => close(false));
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(false);
      });
    });
  }

  private toast(msg: string) {
    let tEl = document.querySelector<HTMLElement>("#ft-toast");
    if (!tEl) {
      tEl = document.createElement("div");
      tEl.id = "ft-toast";
      document.body.appendChild(tEl);
    }
    tEl.textContent = msg;
    tEl.classList.add("show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => tEl!.classList.remove("show"), 1600);
  }
}

let toastTimer: number | undefined;

function dirName(p: string): string {
  if (typeof p !== "string") return String(p ?? "");
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
