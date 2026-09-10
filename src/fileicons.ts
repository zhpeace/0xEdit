// 文件树图标系统：按扩展名着色 + 类型字母/符号

const CODE_EXT: Record<string, string> = {
  js: "js", ts: "ts", jsx: "jsx", tsx: "tsx", json: "json", html: "html",
  css: "css", md: "md", py: "py", rs: "rs", c: "c", h: "h", cpp: "cpp",
  hpp: "hpp", java: "java", go: "go", php: "php", rb: "rb", sh: "sh",
  yml: "yml", yaml: "yaml", xml: "xml", sql: "sql", lua: "lua",
  toml: "toml", ini: "ini", cfg: "cfg", vue: "vue", svg: "svg",
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img",
  ico: "img", pdf: "pdf", zip: "zip", tar: "zip", gz: "zip",
  bz2: "zip", rar: "zip", "7z": "zip",
  txt: "txt", log: "txt", gitignore: "txt", lock: "txt",
  // Office 文档
  xls: "xls", xlsx: "xls", xlsm: "xls", xlsb: "xls", ods: "xls",
  csv: "xls", tsv: "xls",
  doc: "doc", docx: "doc", docm: "doc", dotx: "doc", odt: "doc", rtf: "doc",
  ppt: "ppt", pptx: "ppt", pps: "ppt", ppsx: "ppt", potx: "ppt", odp: "ppt",
  // 字体 / 音频 / 视频 / 二进制 / 数据库
  ttf: "font", otf: "font", woff: "font", woff2: "font", eot: "font",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", m4a: "audio", aac: "audio",
  mp4: "video", mkv: "video", avi: "video", webm: "video", mov: "video",
  exe: "bin", msi: "bin", dll: "bin", dylib: "bin", so: "bin", bin: "bin",
  db: "db", sqlite: "db", sqlite3: "db",
};

// 扩展名 → 图标类别（决定背景色）
export function extFor(name: string): string {
  const base = name.toLowerCase();
  if (base.startsWith(".")) return "hiddendot";
  const parts = base.split(".");
  return CODE_EXT[parts[parts.length - 1]] ?? "file";
}

// 图标类别 → 色块内显示的字母/符号（未知/通用显示文档符号）
const ICON_LABEL: Record<string, string> = {
  js: "JS", ts: "TS", jsx: "JX", tsx: "TX", json: "{}",
  html: "<>", css: "#", md: "MD", py: "PY", rs: "RS",
  c: "C", h: "H", cpp: "C+", hpp: "H+", java: "JV",
  go: "GO", php: "PH", rb: "RB", sh: "SH", yml: "Y", yaml: "Y",
  xml: "X", sql: "SQ", lua: "LU", toml: "TO", ini: "IN", cfg: "CF",
  vue: "VU", svg: "SV", img: "IM", pdf: "PD", zip: "ZP",
  txt: "TX", log: "LG", gitignore: "GI", lock: "LK",
  xls: "XL", doc: "WD", ppt: "PP",
  font: "Aa", audio: "AU", video: "VD", bin: "EX", db: "DB",
  hiddendot: "·", file: "▤",
};

export function iconLabel(cls: string): string {
  return ICON_LABEL[cls] ?? "▤";
}
