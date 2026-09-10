import { t } from "./i18n";

export interface Symbol {
  name: string;
  line: number;
  kind: "class" | "func" | "struct" | "var" | "heading";
  depth: number;
}

function symbolForText(path: string, text: string): Symbol[] {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const out: Symbol[] = [];
  const lines = text.split("\n");
  const patterns: Array<{ re: RegExp; kind: Symbol["kind"] }> = [];

  if (["md", "markdown", "mdown", "mkd", "mdx"].includes(ext)) {
    // Markdown 标题（ATX：# 级；及 setext：下一行 === / --- 视为 H1/H2）
    const mdHeading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(mdHeading);
      if (m) {
        out.push({ name: m[2], line: i + 1, kind: "heading", depth: m[1].length - 1 });
      } else if (i > 0 && /^\s*(={3,}|-{3,})\s*$/.test(lines[i]) && lines[i - 1].trim()) {
        const name = lines[i - 1].trim().replace(/^#{1,6}\s+/, "");
        out.push({ name, line: i, kind: "heading", depth: /={3,}/.test(lines[i]) ? 0 : 1 });
      }
    }
    return out;
  }

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "func" },
      { re: /^\s*(?:export\s+)?class\s+(\w+)/, kind: "class" },
      { re: /^\s*(?:export\s+)?(?:async\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(?[\w\s,]*\)?\s*=>|function)/, kind: "func" },
      { re: /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>,\[\]]+\s*)?\s*\{/, kind: "func" },
      { re: /^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/, kind: "struct" },
    );
  } else if (["py"].includes(ext)) {
    patterns.push(
      { re: /^\s*class\s+(\w+)/, kind: "class" },
      { re: /^\s{0,8}def\s+(\w+)/, kind: "func" },
      { re: /^\s{4,}def\s+(\w+)/, kind: "func" },
    );
  } else if (["rs"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:pub\s+)?fn\s+(\w+)/, kind: "func" },
      { re: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: "struct" },
      { re: /^\s*(?:pub\s+)?enum\s+(\w+)/, kind: "struct" },
      { re: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: "class" },
      { re: /^\s*impl\b/, kind: "class" },
    );
  } else if (["c", "h", "cpp", "hpp", "cxx", "cc", "java", "cs", "go", "m", "mm", "h", "c"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:public|protected|private)?\s*(?:static\s+|inline\s+|virtual\s+|const\s+|final\s+|async\s+|override\s+)*[\w:*<>,\[\]&]+\s+(\w+)\s*\([^;{}]*\)\s*(?:const\s*)?\{/, kind: "func" },
      { re: /^\s*(?:public|protected|private)?\s*(?:static\s+|final\s+|abstract\s+)?class\s+(\w+)/, kind: "class" },
      { re: /^\s*(?:public|protected|private)?\s*(?:struct|interface|enum)\s+(\w+)/, kind: "struct" },
      { re: /^\s*func\s+\([\w*\s,]+\)\s+(\w+)/, kind: "func" },
      { re: /^\s*type\s+(\w+)\s*=\s*func/, kind: "struct" },
    );
  } else if (["lua"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:function\s+)?(\w+)\s*=\s*function\s*\(/, kind: "func" },
      { re: /^\s*function\s+(\w[\w.:]*)\(/, kind: "func" },
    );
  } else if (["php"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:public|protected|private)?\s*(?:static\s+|final\s+|abstract\s+)*(?:function\s+)?(\w+)\s*\(/, kind: "func" },
      { re: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: "class" },
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = (line.match(/^\s*/)![0] as string).length;
    for (const { re, kind } of patterns) {
      const m = line.match(re);
      if (m && m[1]) {
        out.push({ name: m[1], line: i + 1, kind, depth: Math.floor(indent / 2) });
        break;
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export class Outline {
  private el: HTMLElement;
  private onJump: (line: number) => void;

  constructor(el: HTMLElement, onJump: (line: number) => void) {
    this.el = el;
    this.onJump = onJump;
    this.el.innerHTML = `<div class="outline-empty">${t("打开文件后在此显示函数/类列表")}</div>`;
  }

  render(path: string, text: string) {
    if (!text) {
      this.el.innerHTML = `<div class="outline-empty">${t("（空文档）")}</div>`;
      return;
    }
    const symbols = symbolForText(path, text);
    if (!symbols.length) {
      this.el.innerHTML = `<div class="outline-empty">${t("未识别到符号")}</div>`;
      return;
    }
    this.el.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const s of symbols) {
      const row = document.createElement("div");
      row.className = "outline-item";
      row.dataset.line = String(s.line);
      row.style.paddingLeft = `${10 + s.depth * 14}px`;
      const kind = document.createElement("span");
      kind.className = `outline-kind ${s.kind}`;
      kind.textContent = s.kind === "func" ? "ƒ" : s.kind === "class" ? "⌘" : s.kind === "struct" ? "▧" : s.kind === "heading" ? "¶" : "◆";
      const name = document.createElement("span");
      name.className = "outline-name";
      name.textContent = s.name;
      const ln = document.createElement("span");
      ln.className = "outline-line";
      ln.textContent = String(s.line);
      row.append(kind, name, ln);
      frag.appendChild(row);
    }
    this.el.appendChild(frag);
  }

  clear() {
    this.el.innerHTML = `<div class="outline-empty">${t("打开文件后在此显示函数/类列表")}</div>`;
  }

  private jump(target: EventTarget | null) {
    const el = (target as HTMLElement).closest<HTMLElement>(".outline-item");
    if (!el) return;
    const line = parseInt(el.dataset.line || "1", 10);
    this.onJump(line);
  }

  bind() {
    this.el.addEventListener("click", (e) => this.jump(e.target));
  }
}