// 文本转换工具箱：编码转换（Base64/URL/HTML 实体/ASCII-Hex）与行操作（去重/删空行/去行首/排序/反转）。
// 纯函数部分无浏览器依赖，便于单元测试；对话框部分依赖 CodeMirror 的 EditorView。
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { t } from "./i18n.ts";
import { upperCaseCmd, lowerCaseCmd, titleCaseSelection, toggleCaseCmd } from "./editops.ts";

// ---------------- 纯函数（UTF-8 安全，可在 Node 下单测） ----------------
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64Encode(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
export function base64Decode(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}
export function urlEncode(text: string): string {
  return encodeURIComponent(text);
}
export function urlDecode(text: string): string {
  return decodeURIComponent(text);
}
export function htmlEncode(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
export function htmlDecode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
export function toHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) parts.push(bytes[i].toString(16).padStart(2, "0").toUpperCase());
  return parts.join(" ");
}
export function fromHex(hex: string): string {
  const parts = hex.trim().split(/[\s,]+/).filter(Boolean);
  const bytes = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = parseInt(parts[i], 16);
    if (Number.isNaN(v)) throw new Error("invalid hex");
    bytes[i] = v;
  }
  return new TextDecoder().decode(bytes);
}

export function dedupLines(text: string, caseSensitive = false): string {
  const lines = text.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = caseSensitive ? l : l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.join("\n");
}
export function removeBlankLines(text: string): string {
  return text.split("\n").filter((l) => l.trim() !== "").join("\n");
}
export function trimLeading(text: string): string {
  return text.split("\n").map((l) => l.replace(/^\s+/, "")).join("\n");
}
export function sortLines(text: string, desc = false): string {
  const lines = text.split("\n");
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (desc) lines.reverse();
  return lines.join("\n");
}
export function reverseLines(text: string): string {
  return text.split("\n").reverse().join("\n");
}

const FULLWIDTH_SPACE = 0x3000;
const FULLWIDTH_OFFSET = 0xfee0;

export function toHalfWidth(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === FULLWIDTH_SPACE) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - FULLWIDTH_OFFSET);
    else out += ch;
  }
  return out;
}

export function toFullWidth(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20) out += "　";
    else if (code >= 0x21 && code <= 0x7e) out += String.fromCharCode(code + FULLWIDTH_OFFSET);
    else out += ch;
  }
  return out;
}

export function unicodeNormalize(text: string, form: "NFC" | "NFD" | "NFKC" | "NFKD"): string {
  return text.normalize(form);
}

// ---------------- 对话框 ----------------
const FN: Record<string, (s: string) => string> = {
  b64e: base64Encode,
  b64d: base64Decode,
  urle: urlEncode,
  urld: urlDecode,
  htmle: htmlEncode,
  htmld: htmlDecode,
  a2h: toHex,
  h2a: fromHex,
  dedup: (s) => dedupLines(s),
  blank: removeBlankLines,
  lead: trimLeading,
  asc: (s) => sortLines(s, false),
  desc: (s) => sortLines(s, true),
  rev: reverseLines,
  fw2hw: toHalfWidth,
  hw2fw: toFullWidth,
  nfc: (s) => unicodeNormalize(s, "NFC"),
  nfd: (s) => unicodeNormalize(s, "NFD"),
  nfkc: (s) => unicodeNormalize(s, "NFKC"),
  nfkd: (s) => unicodeNormalize(s, "NFKD"),
};

const CASE: Record<string, (v: EditorView) => boolean> = {
  cup: upperCaseCmd,
  clo: lowerCaseCmd,
  ctitle: titleCaseSelection,
  csw: toggleCaseCmd,
};

export function textConvertDialog(view: EditorView) {
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal" style="min-width:460px;max-width:92vw;">
      <div class="modal-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${t("文本转换…")}</span>
        <button class="search-btn" data-close>${t("关闭")}</button>
      </div>
      <div class="modal-body">
        <div class="convert-group"><div class="convert-h">${t("编码转换")}</div>
          <div class="convert-grid">
            <button data-act="b64e">${t("Base64 编码")}</button>
            <button data-act="b64d">${t("Base64 解码")}</button>
            <button data-act="urle">${t("URL 编码")}</button>
            <button data-act="urld">${t("URL 解码")}</button>
            <button data-act="htmle">${t("HTML 实体编码")}</button>
            <button data-act="htmld">${t("HTML 实体解码")}</button>
            <button data-act="a2h">${t("ASCII → Hex")}</button>
            <button data-act="h2a">${t("Hex → ASCII")}</button>
          </div>
        </div>
        <div class="convert-group"><div class="convert-h">${t("行操作")}</div>
          <div class="convert-grid">
            <button data-act="dedup">${t("去重行")}</button>
            <button data-act="blank">${t("删除空行")}</button>
            <button data-act="lead">${t("去行首空白")}</button>
            <button data-act="asc">${t("行升序")}</button>
            <button data-act="desc">${t("行降序")}</button>
            <button data-act="rev">${t("反转行")}</button>
          </div>
        </div>
        <div class="convert-group"><div class="convert-h">${t("大小写")}</div>
          <div class="convert-grid">
            <button data-act="cup">${t("大写")}</button>
            <button data-act="clo">${t("小写")}</button>
            <button data-act="ctitle">${t("标题化")}</button>
            <button data-act="csw">${t("切换大小写")}</button>
          </div>
        </div>
        <div class="convert-group"><div class="convert-h">${t("全角/半角")}</div>
          <div class="convert-grid">
            <button data-act="fw2hw">${t("全角 → 半角")}</button>
            <button data-act="hw2fw">${t("半角 → 全角")}</button>
          </div>
        </div>
        <div class="convert-group"><div class="convert-h">${t("Unicode 归一化")}</div>
          <div class="convert-grid">
            <button data-act="nfc">NFC</button>
            <button data-act="nfd">NFD</button>
            <button data-act="nfkc">NFKC</button>
            <button data-act="nfkd">NFKD</button>
          </div>
        </div>
        <div id="conv-status" class="conv-status"></div>
        <div class="conv-hint">${t("作用于选区；无选区则作用于整个文档。可连续操作。")}</div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const status = modal.querySelector<HTMLElement>("#conv-status")!;
  const setStatus = (msg: string) => {
    status.textContent = msg;
  };

  const applyFn = (act: string) => {
    const fn = FN[act];
    if (!fn) return;
    const sel = view.state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? view.state.doc.length : sel.to;
    const text = view.state.sliceDoc(from, to);
    let out: string;
    try {
      out = fn(text);
    } catch (e) {
      setStatus(t("解码失败：{e}", { e: String(e) }));
      return;
    }
    view.dispatch({
      changes: { from, to, insert: out },
      selection: EditorSelection.single(from, from + out.length),
    });
    view.focus();
    setStatus(t("已应用转换"));
  };

  modal.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.getAttribute("data-act")!;
      if (CASE[act]) {
        CASE[act](view);
        view.focus();
        setStatus(t("已应用转换"));
        return;
      }
      applyFn(act);
    });
  });

  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });
}
