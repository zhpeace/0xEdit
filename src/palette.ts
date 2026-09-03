import { t } from "./i18n";

export interface CommandEntry {
  id: string;
  label: string;
  category: string;
  run: () => void;
}

export class CommandPalette {
  private modal: HTMLElement | null = null;

  open(commands: CommandEntry[]) {
    this.close();
    const modal = document.createElement("div");
    modal.className = "palette-mask";
    modal.innerHTML = `
      <div class="palette">
        <input class="palette-input" id="palette-input" placeholder="${t("输入命令名… (↑↓选择, Enter 执行, Esc 关闭)")}" spellcheck="false"/>
        <div class="palette-list" id="palette-list"></div>
      </div>`;
    document.body.appendChild(modal);
    this.modal = modal;

    const input = modal.querySelector<HTMLInputElement>("#palette-input")!;
    const list = modal.querySelector<HTMLElement>("#palette-list")!;
    let filtered = commands;
    let active = 0;

    const render = () => {
      const q = input.value.toLowerCase();
      filtered = q ? commands.filter((c) => (c.label + c.category).toLowerCase().includes(q)) : commands;
      active = 0;
      list.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const c of filtered) {
        const item = document.createElement("div");
        item.className = "palette-item";
        item.innerHTML = `<span class="palette-cat">${escapeHtml(t(c.category))}</span><span class="palette-label">${escapeHtml(t(c.label))}</span>`;
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.close();
          c.run();
        });
        frag.appendChild(item);
      }
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "palette-empty";
        empty.textContent = t("无匹配命令");
        frag.appendChild(empty);
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
        const cmd = filtered[active];
        if (cmd) {
          this.close();
          cmd.run();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length) active = (active + 1) % filtered.length;
        updateActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length) active = (active - 1 + filtered.length) % filtered.length;
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}