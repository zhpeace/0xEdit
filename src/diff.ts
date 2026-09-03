import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { computeDiff, buildHunks, splitLines, normalize, type Hunk } from "./diff-core";

const inTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

export interface DiffDocRef {
  name: string;
  path?: string;
  read: () => string | Promise<string>;
  applyHunk?: (startLine: number, endLine: number, insertText: string) => void;
}

interface ReadResult {
  text: string;
  is_binary: boolean;
}

type DiffPick =
  | { kind: "doc"; i: number; name: string }
  | { kind: "disk"; name: string; text: string };

async function pickDiskFile(title: string): Promise<{ name: string; text: string } | null> {
  if (inTauri()) {
    const p = (await dialogOpen({ multiple: false, title }).catch(() => null)) as string | null;
    if (!p) return null;
    const r = await invoke<ReadResult>("read_text_file", { path: p }).catch(() => null);
    if (!r || r.is_binary) return null;
    const name = p.split(/[\\/]/).pop() || p;
    return { name, text: r.text };
  }
  const input = document.createElement("input");
  input.type = "file";
  const file = await new Promise<File | null>((resolve) => {
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
  if (!file) return null;
  const text = await file.text();
  return { name: file.name, text };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export async function showDiffDialog(openDocs: DiffDocRef[] = []) {
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal diff-modal">
      <div class="modal-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${t("文件比较")}</span>
        <button class="search-btn" data-close>${t("关闭")}</button>
      </div>
      <div class="diff-toolbar">
        <div class="diff-side"><label>${t("左侧")}</label><select data-side="left"></select></div>
        <div class="diff-side"><label>${t("右侧")}</label><select data-side="right"></select></div>
      </div>
      <div class="diff-toolbar diff-opts">
        <label><input type="checkbox" data-opt="trim" checked/> ${t("忽略行首尾空白")}</label>
        <label><input type="checkbox" data-opt="lower"/> ${t("忽略大小写")}</label>
        <button class="search-btn" data-recompare>${t("重新比较")}</button>
        <span class="diff-merge-all">
          <button class="search-btn" data-mergeall="left" title="${t("把所有差异处用右侧内容覆盖到左侧文档")}">${t("全部：右→左")}</button>
          <button class="search-btn" data-mergeall="right" title="${t("把所有差异处用左侧内容覆盖到右侧文档")}">${t("全部：左→右")}</button>
        </span>
        <span class="diff-nav">
          <button class="search-btn" data-prev>${t("上一处")}</button>
          <button class="search-btn" data-next>${t("下一处")}</button>
          <span data-navinfo>—</span>
        </span>
      </div>
      <div class="diff-head">
        <span class="diff-name diff-left" data-name="left">—</span>
        <span class="diff-name diff-right" data-name="right">—</span>
      </div>
      <div class="diff-stats" data-stats></div>
      <div class="diff-table">
        <div class="diff-row diff-head-row">
          <span class="diff-cell diff-num"></span><span class="diff-cell diff-content">${t("文件 1")}</span>
          <span class="diff-cell diff-num"></span><span class="diff-cell diff-content">${t("文件 2")}</span>
        </div>
        <div class="diff-body" data-body></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const leftSel = modal.querySelector<HTMLSelectElement>('select[data-side="left"]')!;
  const rightSel = modal.querySelector<HTMLSelectElement>('select[data-side="right"]')!;
  const nameLeft = modal.querySelector<HTMLElement>('[data-name="left"]')!;
  const nameRight = modal.querySelector<HTMLElement>('[data-name="right"]')!;
  const statsEl = modal.querySelector<HTMLElement>("[data-stats]")!;
  const bodyEl = modal.querySelector<HTMLElement>("[data-body]")!;
  const navInfo = modal.querySelector<HTMLElement>("[data-navinfo]")!;

  const disk: Record<"left" | "right", { name: string; text: string } | null> = { left: null, right: null };
  let navIndex = 0;
  let hunks: HTMLElement[] = [];
  let hunkListRef: Hunk[] = [];
  let lPick: DiffPick | null = null;
  let rPick: DiffPick | null = null;

  const buildOptions = (sel: HTMLSelectElement) => {
    sel.innerHTML = "";
    openDocs.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = `doc:${i}`;
      opt.textContent = d.path ? `${d.name}  (${d.path})` : d.name;
      sel.appendChild(opt);
    });
    const diskOpt = document.createElement("option");
    diskOpt.value = "disk";
    diskOpt.textContent = t("从磁盘选择…");
    sel.appendChild(diskOpt);
  };

  buildOptions(leftSel);
  buildOptions(rightSel);
  if (openDocs.length >= 1) leftSel.value = "doc:0";
  if (openDocs.length >= 2) rightSel.value = "doc:1";

  const resolvePick = async (side: "left" | "right"): Promise<DiffPick | null> => {
    const sel = side === "left" ? leftSel : rightSel;
    const val = sel.value;
    if (val === "disk") {
      const f = await pickDiskFile(side === "left" ? t("选择左侧文件") : t("选择右侧文件"));
      if (!f) {
        const prev = disk[side] ? "disk" : openDocs.length ? "doc:0" : "disk";
        sel.value = prev;
        return disk[side] ? { kind: "disk", name: disk[side]!.name, text: disk[side]!.text } : null;
      }
      disk[side] = f;
      const opt = sel.querySelector('option[value="disk"]') as HTMLOptionElement;
      opt.textContent = `${t("磁盘：")}${f.name}`;
      return { kind: "disk", name: f.name, text: f.text };
    }
    const i = parseInt(val.slice(4), 10);
    const d = openDocs[i];
    if (!d) return null;
    return { kind: "doc", i, name: d.path ? `${d.name} (${d.path})` : d.name };
  };

  const readText = async (p: DiffPick | null): Promise<string> => {
    if (!p) return "";
    if (p.kind === "disk") return p.text;
    const d = openDocs[p.i];
    return await d.read();
  };

  const setNav = () => {
    hunks.forEach((h, idx) => h.classList.toggle("nav", idx === navIndex));
    if (hunks.length === 0) {
      navInfo.textContent = t("无差异");
      return;
    }
    navInfo.textContent = t("第 {cur} / {total} 处", { cur: navIndex + 1, total: hunks.length });
    hunks[navIndex]?.scrollIntoView({ block: "center" });
  };

  const recompute = async () => {
    lPick = await resolvePick("left");
    rPick = await resolvePick("right");
    const [lText, rText] = await Promise.all([readText(lPick), readText(rPick)]);
    const trim = (modal.querySelector('[data-opt="trim"]') as HTMLInputElement).checked;
    const lower = (modal.querySelector('[data-opt="lower"]') as HTMLInputElement).checked;

    nameLeft.textContent = lPick ? lPick.name : t("（未选择）");
    nameRight.textContent = rPick ? rPick.name : t("（未选择）");

    const lRaw = splitLines(lText);
    const rRaw = splitLines(rText);
    const lNorm = lRaw.map((l) => normalize(l, trim, lower));
    const rNorm = rRaw.map((l) => normalize(l, trim, lower));
    const diff = computeDiff(lNorm, rNorm);

    const same = diff.filter((d) => d.op === "same").length;
    const del = diff.filter((d) => d.op === "del").length;
    const add = diff.filter((d) => d.op === "add").length;
    statsEl.textContent = t("相同 {same} 行 ｜ 仅左 {del} 行 ｜ 仅右 {add} 行", { same, del, add });

    const frag = document.createDocumentFragment();
    const rows: HTMLElement[] = [];
    for (const d of diff) {
      const row = document.createElement("div");
      row.className = "diff-row " + d.op;
      const la = d.a >= 0
        ? `<span class="diff-cell diff-num">${d.a + 1}</span><span class="diff-cell diff-content">${escapeHtml(lRaw[d.a])}</span>`
        : `<span class="diff-cell diff-num"></span><span class="diff-cell diff-content"></span>`;
      const rb = d.b >= 0
        ? `<span class="diff-cell diff-num">${d.b + 1}</span><span class="diff-cell diff-content">${escapeHtml(rRaw[d.b])}</span>`
        : `<span class="diff-cell diff-num"></span><span class="diff-cell diff-content"></span>`;
      row.innerHTML = la + rb;
      frag.appendChild(row);
      rows.push(row);
    }

    const hunkList = buildHunks(diff);
    hunkListRef = hunkList;
    hunks = [];
    for (const h of hunkList) {
      const row = rows[h.firstOpIndex];
      row.classList.add("diff-hunk-start");
      const merge = document.createElement("span");
      merge.className = "diff-merge";
      merge.innerHTML =
        `<button class="search-btn" data-merge="left" title="${t("用左侧内容覆盖到右侧文档")}">${t("← 用左")}</button>` +
        `<button class="search-btn" data-merge="right" title="${t("用右侧内容覆盖到左侧文档")}">${t("用右 →")}</button>`;
      row.appendChild(merge);
      hunks.push(row);
      merge.querySelector('[data-merge="left"]')!.addEventListener("click", (e) => {
        e.stopPropagation();
        doMerge("right", h);
      });
      merge.querySelector('[data-merge="right"]')!.addEventListener("click", (e) => {
        e.stopPropagation();
        doMerge("left", h);
      });
    }
    bodyEl.innerHTML = "";
    bodyEl.appendChild(frag);
    navIndex = 0;
    setNav();
  };

  const doMerge = async (target: "left" | "right", h: Hunk) => {
    const src = target === "left" ? "right" : "left";
    const tPick = target === "left" ? lPick : rPick;
    const sPick = target === "left" ? rPick : lPick;
    if (!tPick || tPick.kind !== "doc") {
      alert(t("目标侧为磁盘文件，暂不支持直接写入，请先在编辑器中打开该文件。"));
      return;
    }
    const ref = openDocs[tPick.i];
    if (!ref.applyHunk) {
      alert(t("目标侧不可写。"));
      return;
    }
    const srcText = sPick && sPick.kind === "disk" ? sPick.text : await readText(sPick);
    const srcLines = splitLines(srcText);
    const sStart = src === "left" ? h.leftStart : h.rightStart;
    const sEnd = src === "left" ? h.leftEnd : h.rightEnd;
    const insertText = srcLines.slice(sStart, sEnd).join("\n");
    const tStart = target === "left" ? h.leftStart : h.rightStart;
    const tEnd = target === "left" ? h.leftEnd : h.rightEnd;
    ref.applyHunk(tStart, tEnd, insertText);
    await recompute();
  };

  const applyAll = async (target: "left" | "right") => {
    let guard = 0;
    while (hunkListRef.length && guard < 10000) {
      guard++;
      await doMerge(target, hunkListRef[0]);
    }
  };

  leftSel.addEventListener("change", recompute);
  rightSel.addEventListener("change", recompute);
  modal.querySelector("[data-recompare]")!.addEventListener("click", recompute);
  modal.querySelector("[data-opt='trim']")!.addEventListener("change", recompute);
  modal.querySelector("[data-opt='lower']")!.addEventListener("change", recompute);
  modal.querySelector("[data-prev]")!.addEventListener("click", () => {
    if (hunks.length === 0) return;
    navIndex = (navIndex - 1 + hunks.length) % hunks.length;
    setNav();
  });
  modal.querySelector("[data-next]")!.addEventListener("click", () => {
    if (hunks.length === 0) return;
    navIndex = (navIndex + 1) % hunks.length;
    setNav();
  });
  modal.querySelector("[data-mergeall='left']")!.addEventListener("click", () => applyAll("left"));
  modal.querySelector("[data-mergeall='right']")!.addEventListener("click", () => applyAll("right"));
  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });

  await recompute();
}
