import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";

const cache = new Map<string, FileEntry[]>();

const CODE_EXT: Record<string, string> = {
  js: "js", ts: "ts", jsx: "jsx", tsx: "tsx", json: "json", html: "html",
  css: "css", md: "md", py: "py", rs: "rs", c: "c", h: "h", cpp: "cpp",
  hpp: "hpp", java: "java", go: "go", php: "php", rb: "rb", sh: "sh",
  yml: "yml", yaml: "yaml", xml: "xml", sql: "sql", lua: "lua",
  toml: "toml", ini: "ini", cfg: "cfg", vue: "vue", svg: "svg",
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img",
  ico: "img", pdf: "pdf", zip: "zip", tar: "zip", gz: "zip",
  txt: "txt", log: "txt", csv: "txt", gitignore: "txt", lock: "txt",
};

function extFor(name: string): string {
  const base = name.toLowerCase();
  if (base.startsWith(".")) return "hiddendot";
  const parts = base.split(".");
  return CODE_EXT[parts[parts.length - 1]] ?? "file";
}

async function list(path: string): Promise<FileEntry[]> {
  let e = cache.get(path);
  if (!e) {
    e = await invoke<FileEntry[]>("list_dir", { path }).catch(() => []);
    cache.set(path, e);
  }
  return e;
}

export class FileTree {
  private el: HTMLElement;
  private root = "";
  private onOpen: (path: string) => void;

  constructor(el: HTMLElement, onOpen: (path: string) => void) {
    this.el = el;
    this.onOpen = onOpen;
    el.addEventListener("click", (e) => this.onClick(e));
  }

  async showRoot(root: string) {
    if (!root || typeof root !== "string") {
      this.root = "";
      this.el.innerHTML = "";
      return;
    }
    this.root = root;
    await this.render(dirName(root));
  }

  wipe() {
    this.el.innerHTML = "";
  }

  private async render(relative: string) {
    const dir = this.root;
    this.el.innerHTML = "";
    const children = await list(dir);
    const frag = document.createDocumentFragment();
    const title = document.createElement("div");
    title.className = "ft-node ft-dir ft-open";
    title.dataset.path = dir;
    title.innerHTML = `<span class="ft-arrow">▾</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(relative)}</span>`;
    frag.appendChild(title);
    frag.appendChild(this.renderChildren(children, dir));
    this.el.appendChild(frag);
  }

  private renderChildren(children: FileEntry[], _dir: string): HTMLElement {
    const ul = document.createElement("div");
    ul.className = "ft-children";
    for (const c of children) {
      if (c.is_dir) {
        const node = document.createElement("div");
        node.className = "ft-node ft-dir";
        node.dataset.path = c.path;
        node.innerHTML = `<span class="ft-arrow">▸</span><span class="ft-ico ft-dir-ico"></span><span class="ft-name">${escapeHtml(c.name)}</span>`;
        ul.appendChild(node);
      } else {
        const node = document.createElement("div");
        node.className = "ft-node ft-file";
        node.dataset.path = c.path;
        node.innerHTML = `<span class="ft-arrow ft-arrow-spacer"></span><span class="ft-ico ft-${extFor(c.name)}"></span><span class="ft-name">${escapeHtml(c.name)}</span>`;
        ul.appendChild(node);
      }
    }
    return ul;
  }

  private async onClick(e: MouseEvent) {
    const node = (e.target as HTMLElement).closest<HTMLElement>(".ft-node");
    if (!node) return;
    const path = node.dataset.path;
    if (!path) return;
    if (node.classList.contains("ft-dir")) {
      const collapsed = node.classList.contains("ft-open");
      if (collapsed) {
        node.classList.remove("ft-open");
        node.querySelector(".ft-arrow")!.textContent = "▸";
        const children = node.nextElementSibling;
        if (children?.classList.contains("ft-children")) {
          (children as HTMLElement).style.display = "none";
        }
      } else {
        node.classList.add("ft-open");
        node.querySelector(".ft-arrow")!.textContent = "▾";
        let children = node.nextElementSibling as HTMLElement | null;
        if (!children || !children.classList.contains("ft-children")) {
          children = this.renderChildren(await list(path), path);
          node.after(children);
        }
        children.style.display = "";
      }
    } else {
      this.onOpen(path);
    }
  }
}

function dirName(p: string): string {
  if (typeof p !== "string") return String(p ?? "");
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}