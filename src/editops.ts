import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { Document } from "./types";

export interface SortOptions {
  desc: boolean;
  numeric: boolean;
  caseSensitive: boolean;
  dedupe: boolean;
  colStart: number;
  colEnd: number;
}

export function sortSelection(view: EditorView, opts: SortOptions): boolean {
  const state = view.state;
  const doc = state.doc;
  const sel = state.selection.main;
  const from = sel.empty ? 0 : Math.min(sel.from, sel.to);
  const to = sel.empty ? doc.length : Math.max(sel.from, sel.to);

  const l0 = doc.lineAt(from).number;
  let l1 = doc.lineAt(Math.max(from, to === from ? to : to - 1)).number;
  if (to <= doc.line(l0).from && l0 === 1 && to === 0) l1 = l0;
  if (to <= doc.line(l1).from) {
    l1 -= 1;
    if (l1 < l0) return false;
  }
  const startLine = doc.line(l0);
  const endLine = doc.line(l1);
  const selFrom = startLine.from;
  let selTo = endLine.to + (l1 < doc.lines ? 1 : 0);

  const text = doc.sliceString(selFrom, selTo);
  let lines = text.split("\n");
  const lastEmpty = lines[lines.length - 1] === "";
  if (lastEmpty) lines.pop();
  if (lines.length <= 1) return false;

  const getKey = (ln: string): number | string => {
    let k = ln;
    if (opts.colStart > 0) {
      const s = opts.colStart - 1;
      const e = opts.colEnd > 0 ? opts.colEnd : undefined;
      k = ln.slice(s, e);
    } else if (opts.colEnd > 0) {
      k = ln.slice(0, opts.colEnd);
    }
    if (opts.numeric) {
      const n = parseFloat((k as string).trim());
      return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
    }
    return opts.caseSensitive ? (k as string) : (k as string).toLowerCase();
  };
  lines.sort((a, b) => {
    const ka = getKey(a);
    const kb = getKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (opts.desc) lines.reverse();

  if (opts.dedupe) {
    const seen = new Set<string>();
    const out2: string[] = [];
    for (const l of lines) {
      const k = String(getKey(l));
      if (seen.has(k)) continue;
      seen.add(k);
      out2.push(l);
    }
    lines = out2;
  }

  let out = lines.join("\n");
  if (lastEmpty || selTo === doc.length) out += "\n";
  view.dispatch({
    changes: { from: selFrom, to: selTo, insert: out },
    selection: EditorSelection.single(selFrom, selFrom + out.length),
  });
  return true;
}

function titleCaseWord(s: string): string {
  return s.replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
}

export function titleCaseSelection(view: EditorView): boolean {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const r of view.state.selection.ranges) {
    const text = view.state.sliceDoc(r.from, r.to);
    changes.push({ from: r.from, to: r.to, insert: titleCaseWord(text) });
  }
  view.dispatch({ changes });
  return true;
}

export interface NumSeqOptions {
  start: number;
  step: number;
  prefix: string;
  suffix: string;
  pad: number;
}

export function insertNumberSequence(view: EditorView, opts: NumSeqOptions): boolean {
  const state = view.state;
  const doc = state.doc;
  const sel = state.selection.main;
  if (sel.empty) return false;
  const fromLine = doc.lineAt(Math.min(sel.from, sel.to)).number;
  const toLine = doc.lineAt(Math.max(sel.from, sel.to)).number;
  const col = Math.min(sel.from, sel.to) - doc.line(fromLine).from;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let n = opts.start;
  for (let l = fromLine; l <= toLine; l++) {
    const line = doc.line(l);
    const at = line.from + Math.min(col, line.length);
    let num = String(n);
    if (opts.pad > 1) num = num.padStart(opts.pad, "0");
    changes.push({ from: at, to: at, insert: opts.prefix + num + opts.suffix });
    n += opts.step;
  }
  view.dispatch({ changes });
  return true;
}

function runOnSelection(view: EditorView, fn: (s: string) => string): boolean {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const r of view.state.selection.ranges) {
    changes.push({ from: r.from, to: r.to, insert: fn(view.state.sliceDoc(r.from, r.to)) });
  }
  view.dispatch({ changes });
  return true;
}

export function upperCaseCmd(view: EditorView): boolean {
  return runOnSelection(view, (s) => s.toUpperCase());
}

export function lowerCaseCmd(view: EditorView): boolean {
  return runOnSelection(view, (s) => s.toLowerCase());
}

export function toggleCaseCmd(view: EditorView): boolean {
  return runOnSelection(view, (s) => {
    let out = "";
    for (const ch of s) {
      const u = ch.toUpperCase();
      out += ch === u ? ch.toLowerCase() : u;
    }
    return out;
  });
}

export function joinLines(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (range.empty) {
    const line = view.state.doc.lineAt(range.head);
    if (line.number >= view.state.doc.lines) return false;
    const next = view.state.doc.line(line.number + 1);
    let insert = next.text;
    if (insert && /[^\s]$/.test(line.text)) insert = " " + insert;
    view.dispatch({
      changes: { from: line.to, to: next.to, insert },
      selection: { anchor: line.to + (insert.startsWith(" ") ? 1 : 0) },
    });
    return true;
  }
  const doc = view.state.doc;
  const first = doc.lineAt(range.from).number;
  const last = doc.lineAt(range.to).number;
  if (first >= last) return false;
  const startLine = doc.line(first);
  const endLine = doc.line(last);
  const text = doc.sliceString(startLine.from, endLine.to).replace(/\n+/g, "");
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: text },
    selection: { anchor: startLine.from + text.length },
  });
  return true;
}

export type LineEnding = "lf" | "crlf" | "cr";

export function convertLineEndings(_view: EditorView, doc: Document, sep: LineEnding): boolean {
  if (doc.lineEnding === sep) return false;
  doc.lineEnding = sep;
  return true;
}

export function lineEndingLabel(le: string): string {
  if (le === "crlf") return "CRLF";
  if (le === "cr") return "CR";
  return "LF";
}

export interface RewrapOptions {
  width: number;
  joinParagraphs: boolean;
}

export function rewrapLines(lines: string[], opts: RewrapOptions): string[] {
  const width = Math.max(20, opts.width);
  const out: string[] = [];
  let para: { indent: string; words: string[] } | null = null;
  const flush = () => {
    if (!para) return;
    const text = para.words.join(" ");
    out.push(...wrapParagraph(text, width, para.indent));
    para = null;
  };
  if (!opts.joinParagraphs) {
    for (const l of lines) out.push(wrapSingleLine(l, width));
    return out;
  }
  for (const l of lines) {
    if (l.trim() === "") {
      flush();
      out.push("");
      continue;
    }
    const indentMatch = l.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    const content = l.slice(indent.length);
    if (!para) para = { indent, words: [] };
    para.words.push(content);
  }
  flush();
  return out;
}

function wrapSingleLine(line: string, width: number): string {
  const indentMatch = line.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "";
  const content = line.slice(indent.length);
  if (content.length <= width - indent.length) return line;
  return wrapParagraph(content, width, indent).join("\n");
}

function wrapParagraph(text: string, width: number, indent: string): string[] {
  let eff = width - indent.length;
  if (eff < 10) eff = 10;
  const words = text.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let cur = "";
  const pushCur = () => {
    if (cur !== "") {
      result.push(indent + cur);
      cur = "";
    }
  };
  for (const w of words) {
    if (w.length > eff) {
      pushCur();
      let rest = w;
      while (rest.length > eff) {
        result.push(indent + rest.slice(0, eff));
        rest = rest.slice(eff);
      }
      cur = rest;
      continue;
    }
    if (cur === "") cur = w;
    else if ((cur + " " + w).length <= eff) cur += " " + w;
    else {
      pushCur();
      cur = w;
    }
  }
  pushCur();
  return result.length ? result : [indent];
}