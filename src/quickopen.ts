import { t } from "./i18n";

export interface QuickOpenFile {
  path: string;
  name: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// ⌘P 快速打开：输入文件名模糊过滤，Enter/点击打开
export class QuickOpen {
  private modal: HTMLElement | null = null;

  open(files: QuickOpenFile[], onPick: (f: QuickOpenFile) => void) {
    this.close();
    const modal = document.createElement("div");
    modal.className = "palette-mask";
    modal.innerHTML = `
      <div class="palette">
        <input class="palette-input" id="quick-input" placeholder="${t("输入文件名… (↑↓选择, Enter 打开, Esc 关闭)")}" spellcheck="false"/>
        <div class="palette-list" id="quick-list"></div>
      </div>`;
    document.body.appendChild(modal);
    this.modal = modal;

    const input = modal.querySelector<HTMLInputElement>("#quick-input")!;
    const list = modal.querySelector<HTMLElement>("#quick-list")!;
    let filtered = files;
    let active = 0;

    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (q) {
        filtered = files.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
      } else {
        filtered = files;
      }
      active = 0;
      list.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const f of filtered.slice(0, 100)) {
        const item = document.createElement("div");
        item.className = "palette-item";
        item.innerHTML = `<span class="palette-cat">${escapeHtml(f.name)}</span><span class="palette-label">${escapeHtml(f.path)}</span>`;
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.close();
          onPick(f);
        });
        frag.appendChild(item);
      }
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "palette-empty";
        empty.textContent = t("无匹配文件");
        frag.appendChild(empty);
      } else if (filtered.length > 100) {
        const more = document.createElement("div");
        more.className = "palette-empty";
        more.textContent = t("仅显示前 100 个匹配（继续输入可缩小范围）");
        frag.appendChild(more);
      }
      list.appendChild(frag);
      updateActive();
    };

    const updateActive = () => {
      const items = list.querySelectorAll<HTMLElement>(".palette-item");
      items.forEach((el, i) => el.classList.toggle("active", i === active));
      items[active]?.scrollIntoView({ block: "nearest" });
    };

    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const f = filtered[active];
        if (f) {
          this.close();
          onPick(f);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length) active = (active + 1) % Math.min(filtered.length, 100);
        updateActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const n = Math.min(filtered.length, 100);
        if (n) active = (active - 1 + n) % n;
        updateActive();
      } else if (e.key === "Escape") {
        this.close();
      }
    });
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal) this.close();
    });

    render();
    input.focus();
  }

  close() {
    this.modal?.remove();
    this.modal = null;
  }
}
