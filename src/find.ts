import type { EditorView, ViewUpdate, DecorationSet } from "@codemirror/view";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder, type Extension } from "@codemirror/state";
import { t } from "./i18n";
import {
  SearchQuery,
  findNext,
  findPrevious,
  setSearchQuery,
  getSearchQuery,
  replaceNext,
  replaceAll,
  SearchCursor,
  RegExpCursor,
} from "@codemirror/search";
import { bookmarkLines } from "./bookmarks";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const setCustomQuery = StateEffect.define<SearchQuery | null>();
const customQueryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCustomQuery)) return e.value;
    return value;
  },
});

const searchMark = Decoration.mark({ class: "cm-searchMatch" });
const selectedMark = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });

function computeHighlights(view: EditorView): DecorationSet {
  const q = view.state.field(customQueryField);
  if (!q || q.search.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const selRanges = view.state.selection.ranges;
  const getCursor = (q as unknown as {
    getCursor: (s: unknown, f: number, t: number) => any;
  }).getCursor.bind(q);
  for (const { from, to } of view.visibleRanges) {
    const cur = getCursor(view.state, from, to) as { next: () => any; value: { from: number; to: number }; done?: boolean };
    while (!cur.next().done) {
      const { from: mf, to: mt } = cur.value;
      const selected = selRanges.some((r) => r.from === mf && r.to === mt);
      builder.add(mf, mt, selected ? selectedMark : searchMark);
    }
  }
  return builder.finish();
}

const searchHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = computeHighlights(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(customQueryField) !== update.state.field(customQueryField)
      ) {
        this.decorations = computeHighlights(update.view);
      }
    }
  },
  { decorations: (v: { decorations: DecorationSet }) => v.decorations },
);

export function searchHighlight(): Extension {
  return [customQueryField, searchHighlightPlugin];
}

function dispatchQuery(view: EditorView, q: SearchQuery | null) {
  view.dispatch({ effects: [setSearchQuery.of(q ?? new SearchQuery({ search: "" })), setCustomQuery.of(q)] });
}

export class FindBar {
  private bar: HTMLElement;
  private findInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private statusLine: HTMLElement;
  private caseBox: HTMLInputElement;
  private regexBox: HTMLInputElement;
  private wordBox: HTMLInputElement;
  private getView: () => EditorView | null;

  constructor(el: HTMLElement, getView: () => EditorView | null) {
    this.bar = el;
    this.getView = getView;
    this.findInput = el.querySelector<HTMLInputElement>("#search-input")!;
    this.replaceInput = el.querySelector<HTMLInputElement>("#replace-input")!;
    this.replaceRow = el.querySelector<HTMLElement>("#replace-row")!;
    this.statusLine = el.querySelector<HTMLElement>("#search-status-line")!;
    this.caseBox = el.querySelector<HTMLInputElement>("#search-case")!;
    this.regexBox = el.querySelector<HTMLInputElement>("#search-regex")!;
    this.wordBox = el.querySelector<HTMLInputElement>("#search-word")!;

    this.bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });

    el.querySelector<HTMLButtonElement>("#search-prev")!.addEventListener("click", () => {
      this.withView((v) => {
        this.syncQuery();
        findPrevious(v);
      });
    });
    el.querySelector<HTMLButtonElement>("#search-next")!.addEventListener("click", () => {
      this.withView((v) => {
        this.syncQuery();
        findNext(v);
      });
    });
    el.querySelector<HTMLButtonElement>("#search-close")!.addEventListener("click", () => this.close());
    el.querySelector<HTMLButtonElement>("#search-count")!.addEventListener("click", () => this.countMatches());
    el.querySelector<HTMLButtonElement>("#search-bookmark")!.addEventListener("click", () => this.bookmarkAll());
    el.querySelector<HTMLButtonElement>("#replace-one")!.addEventListener("click", () => {
      this.withView((v) => {
        this.syncQuery();
        replaceNext(v);
      });
    });
    el.querySelector<HTMLButtonElement>("#replace-all")!.addEventListener("click", () => {
      this.withView((v) => {
        this.syncQuery();
        replaceAll(v);
        this.showStatus(t("已全部替换"));
      });
    });
    el.querySelector<HTMLButtonElement>("#replace-sel")!.addEventListener("click", () => {
      this.withView((v) => {
        this.syncQuery();
        this.replaceSelectionMatch(v);
      });
    });

    this.findInput.addEventListener("input", () => {
      this.withView((v) => {
        this.syncQuery();
        if (v.state.selection.main.empty) findNext(v);
      });
    });
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.withView((v) => {
          this.syncQuery();
          if (e.shiftKey) findPrevious(v);
          else findNext(v);
        });
      }
    });
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.withView((v) => {
          this.syncQuery();
          if (e.shiftKey) replaceAll(v);
          else replaceNext(v);
        });
      }
    });
    [this.caseBox, this.regexBox, this.wordBox].forEach((b) => {
      b.addEventListener("change", () => {
        this.withView((v) => {
          this.syncQuery();
          if (this.findInput.value && v.state.selection.main.empty) findNext(v);
        });
      });
    });
  }

  private withView(fn: (v: EditorView) => void) {
    const v = this.getView();
    if (v) fn(v);
  }

  private buildQuery() {
    return {
      search: this.findInput.value,
      caseSensitive: this.caseBox.checked,
      regexp: this.regexBox.checked,
      wholeWord: this.wordBox.checked,
      replace: this.replaceInput.value,
    };
  }

  private syncQuery() {
    this.withView((v) => {
      const q = this.buildQuery();
      const sq = new SearchQuery({
        search: q.search,
        caseSensitive: q.caseSensitive,
        literal: !q.regexp,
        regexp: q.regexp,
        wholeWord: q.wholeWord,
        replace: q.replace,
      });
      dispatchQuery(v, sq);
    });
  }

  private countMatches() {
    this.withView((v) => {
      const q = this.buildQuery();
      if (!q.search) {
        this.showStatus(t("请输入查找内容"));
        return;
      }
      const n = this.collectMatches(v, q).length;
      this.showStatus(t("共 {n} 处匹配", { n }));
    });
  }

  private bookmarkAll() {
    this.withView((v) => {
      const q = this.buildQuery();
      if (!q.search) {
        this.showStatus(t("请输入查找内容"));
        return;
      }
      const matches = this.collectMatches(v, q);
      const seen = new Set<number>();
      const lineFroms: number[] = [];
      for (const m of matches) {
        const ln = v.state.doc.lineAt(m.from).from;
        if (!seen.has(ln)) {
          seen.add(ln);
          lineFroms.push(ln);
        }
      }
      bookmarkLines(v, lineFroms);
      this.showStatus(t("已在 {n} 行添加书签", { n: lineFroms.length }));
    });
  }

  private collectMatches(v: EditorView, q: { search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }): Array<{ from: number; to: number }> {
    const doc = v.state.doc;
    const matches: Array<{ from: number; to: number }> = [];
    const push = (from: number, to: number) => matches.push({ from, to });
    if (q.regexp) {
      const cur = new RegExpCursor(doc, q.search, {}, 0, doc.length);
      while (!cur.next().done) push(cur.value.from, cur.value.to);
    } else if (q.wholeWord) {
      const cur = new RegExpCursor(doc, `\\b${escapeRegExp(q.search)}\\b`, { ignoreCase: !q.caseSensitive }, 0, doc.length);
      while (!cur.next().done) push(cur.value.from, cur.value.to);
    } else {
      const cur = new SearchCursor(doc, q.search, 0, doc.length, q.caseSensitive ? (s: string) => s : undefined);
      while (!cur.next().done) push(cur.value.from, cur.value.to);
    }
    return matches;
  }

  private replaceSelectionMatch(v: EditorView) {
    const q = getSearchQuery(v.state);
    const main = v.state.selection.main;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    if (q.search.length === 0) return;
    const matches: Array<{ from: number; to: number }> = [];

    if (q.regexp) {
      const cur = new RegExpCursor(v.state.doc, q.search, {}, from, to);
      while (!cur.next().done) matches.push({ from: cur.value.from, to: cur.value.to });
    } else if (q.wholeWord) {
      const escaped = escapeRegExp(q.search);
      const cur = new RegExpCursor(v.state.doc, `\\b${escaped}\\b`, { ignoreCase: !q.caseSensitive }, from, to);
      while (!cur.next().done) matches.push({ from: cur.value.from, to: cur.value.to });
    } else {
      const cur = new SearchCursor(
        v.state.doc,
        q.search,
        from,
        to,
        q.caseSensitive ? (s: string) => s : undefined,
      );
      while (!cur.next().done) matches.push({ from: cur.value.from, to: cur.value.to });
    }

    if (!matches.length) {
      this.showStatus(t("选中区域没有匹配"));
      return;
    }
    v.dispatch({
      changes: matches.map((m) => ({ from: m.from, to: m.to, insert: q.replace })),
      selection: { anchor: from },
    });
    this.showStatus(t("已在选中区域替换 {n} 处", { n: matches.length }));
  }

  private showStatus(msg: string) {
    this.statusLine.textContent = msg;
    this.statusLine.classList.remove("hidden");
  }

  open(options?: { replace?: boolean }) {
    this.bar.classList.remove("hidden");
    this.replaceRow.classList.toggle("hidden", !options?.replace);
    const v = this.getView();
    if (v && this.findInput.value === "") {
      const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
      if (sel && sel.length < 200) this.findInput.value = sel;
    }
    this.findInput.focus();
    this.findInput.select();
  }

  close() {
    this.bar.classList.add("hidden");
    const v = this.getView();
    if (v) v.focus();
  }

  isOpen(): boolean {
    return !this.bar.classList.contains("hidden");
  }
}