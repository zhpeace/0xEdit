import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { t } from "./i18n";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { php } from "@codemirror/lang-php";
import { go } from "@codemirror/lang-go";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { cobol } from "@codemirror/legacy-modes/mode/cobol";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { cypher } from "@codemirror/legacy-modes/mode/cypher";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { gherkin } from "@codemirror/legacy-modes/mode/gherkin";

const L = (p: unknown) => StreamLanguage.define(p as never);

export const LANGUAGE_NAMES: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  sass: "Sass/SCSS",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  java: "Java",
  go: "Go",
  php: "PHP",
  ruby: "Ruby",
  shell: "Shell",
  powershell: "PowerShell",
  yaml: "YAML",
  xml: "XML",
  sql: "SQL",
  lua: "Lua",
  perl: "Perl",
  swift: "Swift",
  toml: "TOML",
  properties: "Properties",
  dockerfile: "Dockerfile",
  groovy: "Groovy",
  verilog: "Verilog",
  vhdl: "VHDL",
  pascal: "Pascal",
  plaintext: t("纯文本"),
};

const BY_EXT: Record<string, () => Extension> = {
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  html: () => html(),
  htm: () => html(),
  xhtml: () => html(),
  vue: () => html(),
  css: () => css(),
  less: () => css(),
  scss: () => L(sass),
  sass: () => L(sass),
  md: () => markdown(),
  markdown: () => markdown(),
  mdx: () => markdown(),
  py: () => python(),
  pyw: () => python(),
  rs: () => rust(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cxx: () => cpp(),
  cc: () => cpp(),
  hpp: () => cpp(),
  hh: () => cpp(),
  java: () => java(),
  cs: () => cpp(),
  go: () => go(),
  php: () => php(),
  phtml: () => php(),
  rb: () => L(ruby),
  sh: () => L(shell),
  bash: () => L(shell),
  zsh: () => L(shell),
  yml: () => yaml(),
  yaml: () => yaml(),
  xml: () => xml(),
  svg: () => xml(),
  sql: () => sql(),
  lua: () => L(lua),
  pl: () => L(perl),
  pm: () => L(perl),
  sw: () => L(swift),
  toml: () => L(toml),
  ini: () => L(properties),
  cfg: () => L(properties),
  conf: () => L(properties),
  properties: () => L(properties),
  env: () => L(properties),
  gradle: () => L(groovy),
  m: () => cpp(),
  mm: () => cpp(),
  dockerfile: () => L(dockerFile),
  diff: () => L(diff),
  patch: () => L(diff),
  bat: () => L(vbScript),
  cmd: () => L(vbScript),
  ps1: () => L(powerShell),
  feature: () => L(gherkin),
  clj: () => L(clojure),
  cljs: () => L(clojure),
  cljc: () => L(clojure),
  lisp: () => L(commonLisp),
  elm: () => L(elm),
  erl: () => L(erlang),
  hrl: () => L(erlang),
  hs: () => L(haskell),
  lhs: () => L(haskell),
  jl: () => L(julia),
  n: () => L(mathematica),
  nb: () => L(mathematica),
  tcl: () => L(tcl),
  v: () => L(verilog),
  vhd: () => L(vhdl),
  pas: () => L(pascal),
  cob: () => L(cobol),
  coffee: () => L(coffeeScript),
  cypher: () => L(cypher),
  proto: () => L(protobuf),
  txt: () => [],
  text: () => [],
  log: () => [],
  gitignore: () => L(properties),
  makefile: () => L(cmake),
  dockerignore: () => L(properties),
  editorconfig: () => L(properties),
  webmanifest: () => json(),
  webapp: () => json(),
  csv: () => [],
  tsv: () => [],
  graphql: () => [],
  yamlpkg: () => yaml(),
  man: () => [],
  rst: () => [],
  adoc: () => [],
  glsl: () => cpp(),
  fgl: () => cpp(),
  vert: () => cpp(),
  frag: () => cpp(),
};

export function langForPath(path: string): { ext: Extension; name: string } {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const lower = fileName.toLowerCase();
  const base = lower.split(".").pop() ?? "";

  if (lower === "makefile") return { ext: L(cmake), name: "Makefile" };
  if (lower === "dockerfile") return { ext: L(dockerFile), name: "Dockerfile" };
  if (lower.endsWith("c")) {}

  const factory = BY_EXT[base];
  if (factory) {
    const name = LANGUAGE_NAMES[base] ?? base;
    return { ext: factory(), name };
  }
  return { ext: [], name: t("纯文本") };
}

const textExts = [
  "txt", "text", "md", "log", "csv", "tsv", "json", "js", "ts", "jsx", "tsx",
  "html", "htm", "css", "xml", "yml", "yaml", "py", "rb", "php", "sh", "rs",
  "go", "java", "c", "h", "cpp", "hpp", "cs", "sql", "toml", "ini", "cfg",
  "conf", "properties", "env", "gitignore", "dockerfile", "makefile",
  "vue", "swift", "kt", "lua", "pl", "ps1", "bat", "cmd", "scss", "less",
  "sass", "gradle", "scala", "m", "mm", "graphql", "diff", "patch",
  "webmanifest", "clj", "cljs", "cljc", "lisp", "elm", "erl", "hs", "jl",
  "mdx", "coffee", "vim", "csh", "tsv",
];

export function isTextLike(path: string): boolean {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (textExts.includes(ext)) return true;
  return false;
}