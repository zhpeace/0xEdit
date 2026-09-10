// Markdown 实时预览：把当前文档渲染为 HTML 并与编辑器滚动同步。
// 仅在当前文件为 Markdown 时可用；渲染到普通 div 以继承应用主题变量。
import { marked } from "marked";

const MD_EXT = /\.(md|markdown|mdown|mkd|mdwn|mdx)$/i;

export function isMarkdownDoc(path?: string, name?: string): boolean {
  const s = (path || name || "").toLowerCase();
  return MD_EXT.test(s);
}

// 轻量净化：去除可执行的脚本/外部资源与事件属性。本地应用渲染用户自有内容，足够。
function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');
}

export function renderMarkdown(src: string): string {
  let html: string | Promise<string> = marked.parse(src, { async: false, gfm: true, breaks: true });
  if (typeof html !== "string") html = "";
  return sanitizeHtml(html);
}

interface EditorLike {
  scrollDOM: HTMLElement;
  state: { doc: { toString(): string } };
}

export class MarkdownPreview {
  onTaskToggle: ((line: number, checked: boolean) => void) | null = null;
  private panel: HTMLElement;
  private content: HTMLElement;
  private view: EditorLike | null = null;
  private syncing = false;
  private edHandler: (() => void) | null = null;
  private pvHandler: (() => void) | null = null;

  constructor(panel: HTMLElement) {
    this.panel = panel;
    panel.classList.add("markdown-preview");
    // 无头部条：预览内容与左栏编辑器从同一水平线开始（关闭预览用 ⇧⌘E/菜单/工具栏）
    panel.innerHTML = `<div id="pv-body"></div>`;
    this.content = panel.querySelector("#pv-body")!;
  }

  show(src: string) {
    this.content.innerHTML = renderMarkdown(src);
    // 任务列表勾选闭环：源文本中的任务行按顺序对应预览里的 checkbox，点击回写编辑区
    const taskLines: number[] = [];
    src.split("\n").forEach((l, i) => {
      if (/^\s*[-*]\s*\[[ xX]\]/.test(l)) taskLines.push(i + 1);
    });
    if (taskLines.length) {
      const boxes = this.content.querySelectorAll<HTMLInputElement>("li input[type=checkbox]");
      boxes.forEach((box, i) => {
        const line = taskLines[i];
        if (!line) return;
        box.disabled = false;
        box.removeAttribute("disabled");
        box.addEventListener("change", () => this.onTaskToggle?.(line, box.checked));
      });
    }
    this.content.scrollTop = 0;
  }

  attach(view: EditorLike) {
    if (this.view === view) return;
    this.view = view;
    this.edHandler = () => this.syncToPreview();
    this.pvHandler = () => this.syncToEditor();
    view.scrollDOM.addEventListener("scroll", this.edHandler);
    this.content.addEventListener("scroll", this.pvHandler);
  }

  // 光标位置 → 预览按行比例跟随（覆盖仅滚动不触发的场景，如光标跳回顶部）
  syncCursor(line: number, total: number) {
    const r = total > 1 ? (line - 1) / (total - 1) : 0;
    if (!this.syncing) this.setRatio(this.content, r);
  }

  private ratio(el: HTMLElement): number {
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  }
  private setRatio(el: HTMLElement, r: number) {
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.round(r * max);
  }

  private syncToPreview() {
    if (this.syncing || !this.view) return;
    this.syncing = true;
    this.setRatio(this.content, this.ratio(this.view.scrollDOM));
    setTimeout(() => (this.syncing = false), 50);
  }
  private syncToEditor() {
    if (this.syncing || !this.view) return;
    this.syncing = true;
    this.setRatio(this.view.scrollDOM, this.ratio(this.content));
    setTimeout(() => (this.syncing = false), 50);
  }

  destroy() {
    if (this.edHandler && this.view) this.view.scrollDOM.removeEventListener("scroll", this.edHandler);
    if (this.pvHandler) this.content.removeEventListener("scroll", this.pvHandler);
    this.panel.innerHTML = "";
    this.panel.classList.remove("markdown-preview");
    this.view = null;
  }
}
