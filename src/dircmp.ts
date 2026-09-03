import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

interface CmpItem {
  rel: string;
  exists_left: boolean;
  exists_right: boolean;
  is_dir: boolean;
  size_left: number;
  size_right: number;
  modified_left: number;
  modified_right: number;
  same: boolean;
}

function joinDir(dir: string, rel: string): string {
  return dir.replace(/\/+$/, "") + "/" + rel;
}

export async function showDirCompare() {
  const left = await dialogOpen({ directory: true, multiple: false, title: t("选择左侧目录") });
  if (!left) return;
  const right = await dialogOpen({ directory: true, multiple: false, title: t("选择右侧目录") });
  if (!right) return;

  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal dircmp">
      <div class="modal-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${t("目录比较 / 同步")}</span>
        <button class="search-btn" data-close>${t("关闭")}</button>
      </div>
      <div class="diff-head">
        <span class="diff-name diff-left">${escapeHtml(left)}</span>
        <span class="diff-name diff-right">${escapeHtml(right)}</span>
      </div>
      <div class="dircmp-toolbar">
        <span id="dc-status">${t("比较中…")}</span>
        <button class="search-btn" data-copy="left">${t("← 左侧 → 右侧")}</button>
        <button class="search-btn" data-copy="right">${t("→ 右侧 → 左侧")}</button>
      </div>
      <div class="dc-list" id="dc-list"></div>
    </div>`;
  document.body.appendChild(modal);

  const list = modal.querySelector<HTMLElement>("#dc-list")!;
  const status = modal.querySelector<HTMLElement>("#dc-status")!;
  let items: CmpItem[] = [];

  const render = () => {
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    let files = 0;
    for (const it of items) {
      if (!it.is_dir && it.exists_left && it.exists_right && it.same) {
        files++;
        continue;
      }
      const row = document.createElement("div");
      row.className = "dc-row";
      const state = !it.exists_left ? "add" : !it.exists_right ? "del" : it.same ? "same" : "diff";
      row.dataset.rel = it.rel;
      const st = document.createElement("span");
      st.className = `dc-state ${state}`;
      st.textContent = state === "same" ? "=" : state === "diff" ? "≠" : state === "add" ? "+" : "−";
      const name = document.createElement("span");
      name.className = "dc-name";
      name.textContent = it.rel + (it.is_dir ? "/" : "");
      const size = document.createElement("span");
      size.className = "dc-size";
      size.textContent = it.is_dir ? "" : `${it.size_left || it.size_right} B`;
      row.append(st, name, size);
      if (!it.is_dir) {
        row.style.cursor = "pointer";
        row.title = t("双击合并编辑");
        row.addEventListener("dblclick", () => {
          openMergeModal(joinDir(left, it.rel), joinDir(right, it.rel), it.rel);
        });
      }
      frag.appendChild(row);
    }
    list.appendChild(frag);
    status.textContent = t("共 {items} 项，需关注 {n} 项；相同文件自动隐藏", { items: items.length, n: list.childElementCount });
  };

  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.querySelector('[data-copy="left"]')!.addEventListener("click", async () => {
    await sync("left");
  });
  modal.querySelector('[data-copy="right"]')!.addEventListener("click", async () => {
    await sync("right");
  });

  const sync = async (dir: "left" | "right") => {
    let count = 0;
    for (const it of items) {
      if (it.is_dir) continue;
      if (dir === "left" && it.exists_left && it.exists_right && it.same) continue;
      if (dir === "right" && it.exists_left && it.exists_right && it.same) continue;
      status.textContent = t("同步中…");
      try {
        if (dir === "left") {
          if (!it.exists_left) continue;
          await invoke("copy_file", { src: joinDir(left, it.rel), dst: joinDir(right, it.rel) });
        } else {
          if (!it.exists_right) continue;
          await invoke("copy_file", { src: joinDir(right, it.rel), dst: joinDir(left, it.rel) });
        }
        count++;
      } catch {
        /* skip failure */
      }
    }
    await reload();
    status.textContent = count > 0 ? t("已同步 {count} 个文件", { count }) : t("没有可同步的文件（仅左侧或仅右侧且方向不匹配时跳过）");
  };

  const reload = async () => {
    status.textContent = t("比较中…");
    items = await invoke<CmpItem[]>("compare_dirs", { left, right }).catch(() => []);
    render();
  };

  await reload();
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

async function openMergeModal(leftPath: string, rightPath: string, rel: string) {
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal merge-modal" style="min-width:760px;max-width:94vw;">
      <div class="modal-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${t("合并编辑")}: ${escapeHtml(rel)}</span>
        <button class="search-btn" data-close>${t("关闭")}</button>
      </div>
      <div class="merge-grid">
        <div class="merge-pane">
          <div class="merge-cap">${t("左侧（只读）")}</div>
          <textarea class="merge-ta" id="m-left" readonly spellcheck="false"></textarea>
        </div>
        <div class="merge-pane">
          <div class="merge-cap">${t("右侧（只读）")}</div>
          <textarea class="merge-ta" id="m-right" readonly spellcheck="false"></textarea>
        </div>
        <div class="merge-pane">
          <div class="merge-cap" style="display:flex;justify-content:space-between;align-items:center;">
            <span>${t("合并结果")}</span>
            <span>
              <button class="search-btn" id="m-use-left">${t("用左侧填充")}</button>
              <button class="search-btn" id="m-use-right">${t("用右侧填充")}</button>
            </span>
          </div>
          <textarea class="merge-ta" id="m-merged" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="dircmp-toolbar" style="margin-top:10px;">
        <span id="m-status"></span>
        <button class="search-btn" id="m-save-left">${t("保存到左侧")}</button>
        <button class="search-btn" id="m-save-right">${t("保存到右侧")}</button>
        <button class="search-btn" id="m-save-both">${t("保存到两侧")}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const leftTa = modal.querySelector<HTMLTextAreaElement>("#m-left")!;
  const rightTa = modal.querySelector<HTMLTextAreaElement>("#m-right")!;
  const mergedTa = modal.querySelector<HTMLTextAreaElement>("#m-merged")!;
  const status = modal.querySelector<HTMLElement>("#m-status")!;
  let encL = "utf-8", leL = "lf", encR = "utf-8", leR = "lf";

  const readOne = async (path: string) =>
    invoke<{ text: string; is_binary: boolean; encoding: string; line_endings: string }>("read_text_file", { path }).catch(() => null);

  status.textContent = t("读取中…");
  const [rl, rr] = await Promise.all([readOne(leftPath), readOne(rightPath)]);
  if (!rl || !rr) {
    status.textContent = t("读取失败，无法合并");
    modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
    modal.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.remove(); });
    return;
  }
  if (rl.is_binary || rr.is_binary) {
    status.textContent = t("该文件是二进制，无法内联合并");
    leftTa.value = rl.is_binary ? t("（二进制文件）") : rl.text;
    rightTa.value = rr.is_binary ? t("（二进制文件）") : rr.text;
  } else {
    encL = rl.encoding; leL = rl.line_endings; encR = rr.encoding; leR = rr.line_endings;
    leftTa.value = rl.text;
    rightTa.value = rr.text;
    mergedTa.value = rl.text;
  }

  const saveSide = async (which: "left" | "right") => {
    if (rl!.is_binary || rr!.is_binary) {
      status.textContent = t("该文件是二进制，无法内联合并");
      return;
    }
    const path = which === "left" ? leftPath : rightPath;
    const enc = which === "left" ? encL : encR;
    const le = which === "left" ? leL : leR;
    try {
      await invoke("save_text_file", { path, text: mergedTa.value, encoding: enc, line_ending: le, backup: true });
      status.textContent = which === "left" ? t("已保存到左侧") : t("已保存到右侧");
    } catch (e) {
      status.textContent = t("保存失败：{e}", { e: String(e) });
    }
  };

  modal.querySelector("#m-use-left")!.addEventListener("click", () => { mergedTa.value = leftTa.value; });
  modal.querySelector("#m-use-right")!.addEventListener("click", () => { mergedTa.value = rightTa.value; });
  modal.querySelector("#m-save-left")!.addEventListener("click", () => saveSide("left"));
  modal.querySelector("#m-save-right")!.addEventListener("click", () => saveSide("right"));
  modal.querySelector("#m-save-both")!.addEventListener("click", async () => {
    await saveSide("left");
    await saveSide("right");
    status.textContent = t("已保存到两侧");
  });
  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.remove(); });
}