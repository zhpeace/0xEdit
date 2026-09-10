// 目录树排序（Finder 式）：文件夹恒前 + 名称智能排序（数字感知/忽略大小写与标点）
// 排序字段：名称 / 大小 / 修改时间 / 类型；升/降序可切换；偏好持久化，本地/远程/归档内共用。
import { t } from "./i18n";

export type TreeSortField = "name" | "size" | "mtime" | "kind";
export interface TreeSortState {
  field: TreeSortField;
  desc: boolean;
}
export interface SortableEntry {
  name: string;
  isDir?: boolean;
  is_dir?: boolean;
  size?: number;
  modified?: number;
}

function isDirOf(e: SortableEntry): boolean {
  return e.isDir ?? e.is_dir ?? false;
}

const STORE_KEY = "uec.treeSort";
const DEFAULT_SORT: TreeSortState = { field: "name", desc: false };

export function loadTreeSort(): TreeSortState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as TreeSortState;
      if (v && (v.field === "name" || v.field === "size" || v.field === "mtime" || v.field === "kind") && typeof v.desc === "boolean") {
        return v;
      }
    }
  } catch {
    /* 忽略损坏数据 */
  }
  return { ...DEFAULT_SORT };
}

export function saveTreeSort(s: TreeSortState): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

// Finder 名称智能比较：数字感知、忽略大小写、忽略标点/空格
function nameCompare(a: string, b: string): number {
  try {
    return a.localeCompare(b, "zh", { numeric: true, sensitivity: "base", ignorePunctuation: true });
  } catch {
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  }
}

function kindOf(e: SortableEntry): string {
  if (isDirOf(e)) return "";
  const i = e.name.lastIndexOf(".");
  return i > 0 ? e.name.slice(i + 1).toLowerCase() : "";
}

export function compareEntries(a: SortableEntry, b: SortableEntry, s: TreeSortState): number {
  const aDir = isDirOf(a);
  const bDir = isDirOf(b);
  // 文件夹恒在文件前（升降序都不影响）
  if (aDir !== bDir) return aDir ? -1 : 1;
  const dir = s.desc ? -1 : 1;
  switch (s.field) {
    case "size": {
      const sa = aDir ? -1 : a.size ?? -1;
      const sb = bDir ? -1 : b.size ?? -1;
      if (sa !== sb) return (sa - sb) * dir;
      return nameCompare(a.name, b.name);
    }
    case "mtime": {
      const ma = a.modified && a.modified > 0 ? a.modified : 0;
      const mb = b.modified && b.modified > 0 ? b.modified : 0;
      if ((ma === 0) !== (mb === 0)) return ma === 0 ? 1 : -1; // 缺失时间恒排最后
      if (ma !== mb) return (ma - mb) * dir;
      return nameCompare(a.name, b.name);
    }
    case "kind": {
      const ka = kindOf(a);
      const kb = kindOf(b);
      if (ka !== kb) return dir === 1 ? ka.localeCompare(kb) : kb.localeCompare(ka);
      return nameCompare(a.name, b.name);
    }
    default:
      return nameCompare(a.name, b.name) * dir;
  }
}

export function sortEntries<T extends SortableEntry>(entries: T[], s: TreeSortState): T[] {
  return [...entries].sort((a, b) => compareEntries(a, b, s));
}

// 修改时间列：今年显示 MM-DD HH:mm，跨年显示 YYYY-MM-DD；无数据返回空
export function fmtTime(secs?: number): string {
  if (!secs || secs <= 0) return "";
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 类型列：取扩展名（Finder 风格，原样保留大小写）；无扩展名/点文件返回空
export function kindLabel(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

const FIELD_KEYS: Array<{ field: TreeSortField; label: string }> = [
  { field: "name", label: "名称" },
  { field: "size", label: "大小" },
  { field: "mtime", label: "修改时间" },
  { field: "kind", label: "类型" },
];

// 生成 Finder 列表视图式排序栏：点击字段切换依据，再点同一字段切换升/降序
export function createSortBar(state: TreeSortState, onSort: (s: TreeSortState) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ft-sortbar";
  for (const { field, label } of FIELD_KEYS) {
    const item = document.createElement("span");
    item.className = "ft-sort-item" + (state.field === field ? " active" : "");
    item.dataset.field = field;
    item.title = t("排序：点击切换字段，再次点击切换升/降序");
    const arrow = state.field === field ? (state.desc ? " ↓" : " ↑") : "";
    item.textContent = t(label) + arrow;
    item.addEventListener("click", () => {
      const next: TreeSortState =
        state.field === field ? { field, desc: !state.desc } : { field, desc: false };
      saveTreeSort(next);
      onSort(next);
    });
    bar.appendChild(item);
  }
  return bar;
}
