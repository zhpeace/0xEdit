import { t } from "./i18n";

export type ToolResult = { ok: boolean; text: string; error?: string };

export function formatJson(text: string, indent = 2): ToolResult {
  try {
    const parsed = JSON.parse(text);
    return { ok: true, text: JSON.stringify(parsed, null, indent) };
  } catch (e) {
    return { ok: false, text, error: (e as Error).message };
  }
}

export function minifyJson(text: string): ToolResult {
  try {
    const parsed = JSON.parse(text);
    return { ok: true, text: JSON.stringify(parsed) };
  } catch (e) {
    return { ok: false, text, error: (e as Error).message };
  }
}

export function formatHtml(text: string): ToolResult {
  const voidTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
  ]);
  const tokenRe = /(<\/?[a-zA-Z][^<>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<[^<>]+>)|([^<]+)/g;
  const out: string[] = [];
  let indent = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m[1]) {
      const t = m[1];
      const closer = /^<\//.test(t);
      const opener = /^<[^!/]/.test(t);
      const selfClose = /\/>$/.test(t) || voidTags.has((t.match(/^<([a-zA-Z][\w-]*)/) ?? [])[1] ?? "");
      if (closer) indent = Math.max(0, indent - 1);
      out.push("  ".repeat(indent) + t);
      if (opener && !selfClose) indent += 1;
    } else if (m[2]) {
      const txt = m[2].replace(/[ \t\r\n]+/g, " ").trim();
      if (!txt) continue;
      if (out.length) {
        out[out.length - 1] += " " + txt;
      } else {
        out.push("  ".repeat(indent) + txt);
      }
    }
  }
  if (!out.length) return { ok: false, text, error: t("没有可识别的 HTML 标签") };
  return { ok: true, text: out.join("\n") };
}

export function formatXml(text: string, indentStr = "  "): ToolResult {
  const tokenRe =
    /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[a-zA-Z][^<>]*>)|([^<]+)/g;
  const out: string[] = [];
  let indent = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m[1]) {
      const t = m[1];
      if (/^<\//.test(t)) {
        indent = Math.max(0, indent - 1);
        out.push(indentStr.repeat(indent) + t);
      } else if (/^<\?|<!--|<!\[CDATA|<!DOCTYPE/.test(t)) {
        out.push(indentStr.repeat(indent) + t);
      } else {
        const selfClose = /\/>$/.test(t);
        out.push(indentStr.repeat(indent) + t);
        if (!selfClose) indent += 1;
      }
    } else if (m[2]) {
      const txt = m[2].replace(/[ \t\r\n]+/g, " ").trim();
      if (!txt) continue;
      if (out.length) {
        out[out.length - 1] += " " + txt;
      } else {
        out.push(indentStr.repeat(indent) + txt);
      }
    }
  }
  if (!out.length) return { ok: false, text, error: t("没有可识别的 XML 标签") };
  return { ok: true, text: out.join("\n") };
}

export function base64Encode(text: string): ToolResult {
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return { ok: true, text: btoa(bin) };
  } catch (e) {
    return { ok: false, text, error: (e as Error).message };
  }
}

export function base64Decode(text: string): ToolResult {
  try {
    const bin = atob(text.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
  } catch (e) {
    return { ok: false, text, error: (e as Error).message };
  }
}

export function urlEncode(text: string): ToolResult {
  return { ok: true, text: encodeURIComponent(text) };
}

export function urlDecode(text: string): ToolResult {
  try {
    return { ok: true, text: decodeURIComponent(text) };
  } catch {
    try {
      return { ok: true, text: unescape(text) };
    } catch (e) {
      return { ok: false, text, error: (e as Error).message };
    }
  }
}

export function indentToSpaces(text: string, tabSize = 4): ToolResult {
  const out = text.replace(/^( *)\t/gm, (_m, sp: string) => sp + " ".repeat(tabSize));
  return { ok: true, text: out };
}

export function indentToTabs(text: string, tabSize = 4): ToolResult {
  const out = text.replace(/^( {1," + tabSize + "})+/gm, (m) => {
    const total = m.length;
    const tabs = Math.floor(total / tabSize);
    const rest = total % tabSize;
    return "\t".repeat(tabs) + " ".repeat(rest);
  });
  return { ok: true, text: out };
}

export interface WordCount {
  chars: number;
  charsNoSpace: number;
  words: number;
  lines: number;
  bytes: number;
}

export function countText(text: string): WordCount {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    chars: [...text].length,
    charsNoSpace: text.replace(/\s/g, "").length,
    words,
    lines: text ? text.split("\n").length : 0,
    bytes: new TextEncoder().encode(text).length,
  };
}