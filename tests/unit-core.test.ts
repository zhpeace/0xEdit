// 核心纯函数单元测试（无浏览器 / CodeMirror / Tauri 依赖）。
// 运行： node --test --experimental-strip-types tests/unit-core.test.ts
// 或：   npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeDiff,
  buildHunks,
  splitLines,
  normalize,
} from "../src/diff-core.ts";
import { computeRectRanges, type RectLine } from "../src/rect-core.ts";
import { isMarkdownDoc, renderMarkdown } from "../src/markdown-preview.ts";
import {
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  htmlEncode,
  htmlDecode,
  toHex,
  fromHex,
  dedupLines,
  removeBlankLines,
  trimLeading,
  sortLines,
  reverseLines,
  toHalfWidth,
  toFullWidth,
  unicodeNormalize,
} from "../src/convert.ts";

// ---------------- diff: splitLines ----------------
test("splitLines 统一换行符并按 \\n 切分", () => {
  assert.deepEqual(splitLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitLines(""), [""]);
  assert.deepEqual(splitLines("x\ny\n"), ["x", "y", ""]);
});

// ---------------- diff: normalize ----------------
test("normalize 支持 trim / lower", () => {
  assert.equal(normalize("  AbC  ", true, true), "abc");
  assert.equal(normalize("AbC", false, true), "abc");
  assert.equal(normalize("  AbC", true, false), "AbC");
});

// ---------------- diff: computeDiff 基本性质 ----------------
test("computeDiff 两条相同文本全为 same", () => {
  const a = ["1", "2", "3"];
  const ops = computeDiff(a, a);
  assert.equal(ops.length, 3);
  assert.ok(ops.every((o) => o.op === "same"));
});

test("computeDiff 空对空为空", () => {
  assert.equal(computeDiff([], []).length, 0);
});

test("computeDiff 左空右有内容全为 add", () => {
  const ops = computeDiff([], ["x", "y"]);
  assert.deepEqual(ops.map((o) => o.op), ["add", "add"]);
});

test("computeDiff 右空左有内容全为 del", () => {
  const ops = computeDiff(["x", "y"], []);
  assert.deepEqual(ops.map((o) => o.op), ["del", "del"]);
});

test("computeDiff 一行被替换为两行", () => {
  const ops = computeDiff(["a", "b", "c"], ["a", "B1", "B2", "c"]);
  assert.deepEqual(ops.map((o) => o.op), ["same", "del", "add", "add", "same"]);
});

test("computeDiff 与朴素 LCS 结果一致（随机用例）", () => {
  const lcs = (a: string[], b: string[]) => {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0, same = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { same++; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return same;
  };
  const rng = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  };
  for (let t = 0; t < 200; t++) {
    const r = rng(t + 1);
    const gen = () => {
      const len = Math.floor(r() * 8);
      const out: string[] = [];
      for (let k = 0; k < len; k++) out.push(["x", "y", "z"][Math.floor(r() * 3)]);
      return out;
    };
    const a = gen(), b = gen();
    const ops = computeDiff(a, b);
    const same = ops.filter((o) => o.op === "same").length;
    // 还原后的 same 行数应等于 LCS 长度
    assert.equal(same, lcs(a, b), `trial ${t}`);
    // 删除/新增行数守恒
    assert.equal(ops.filter((o) => o.op === "del").length, a.length - same);
    assert.equal(ops.filter((o) => o.op === "add").length, b.length - same);
  }
});

// ---------------- diff: buildHunks ----------------
test("buildHunks 把连续差异聚合成块", () => {
  const ops = computeDiff(["a", "b", "c"], ["a", "B1", "B2", "c"]);
  const hunks = buildHunks(ops);
  assert.equal(hunks.length, 1);
  assert.deepEqual(
    [hunks[0].leftStart, hunks[0].leftEnd, hunks[0].rightStart, hunks[0].rightEnd],
    [1, 2, 1, 3],
  );
});

test("buildHunks 正确处理多处不相邻差异", () => {
  const ops = computeDiff(["1", "2", "3", "4", "5"], ["1", "x", "3", "y", "5"]);
  const hunks = buildHunks(ops);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].leftStart, hunks[0].leftEnd], [1, 2]);
  assert.deepEqual([hunks[1].leftStart, hunks[1].leftEnd], [3, 4]);
});

test("buildHunks 全相同无块", () => {
  assert.equal(buildHunks(computeDiff(["a", "b"], ["a", "b"])).length, 0);
});

// ---------------- rect: computeRectRanges ----------------
// 简易文档：每行 from/length
const doc = (rows: string[]): RectLine[] => {
  let off = 0;
  return rows.map((r) => {
    const line = { from: off, length: r.length };
    off += r.length + 1; // +1 模拟换行符
    return line;
  });
};

test("computeRectRanges 单行矩形即普通选择", () => {
  const lines = doc(["hello"]);
  const r = computeRectRanges({ line: 1, col: 1 }, { line: 1, col: 3 }, lines);
  assert.deepEqual(r, [{ from: 1, to: 3 }]);
});

test("computeRectRanges 多行矩形逐行生成区间", () => {
  // 行: "abc"(0..3) "defg"(4..8) "hi"(9..11)
  const lines = doc(["abc", "defg", "hi"]);
  const r = computeRectRanges({ line: 1, col: 1 }, { line: 3, col: 2 }, lines);
  assert.deepEqual(r, [
    { from: 1, to: 2 }, // "abc" col1..2
    { from: 5, to: 6 }, // "defg" col1..2 -> from 4+1..4+2
    { from: 10, to: 11 }, // "hi" col1..2 -> from 9+1..9+2
  ]);
});

test("computeRectRanges 角点顺序无关（取包围盒）", () => {
  const lines = doc(["abc", "defg", "hi"]);
  const a = computeRectRanges({ line: 3, col: 2 }, { line: 1, col: 1 }, lines);
  const b = computeRectRanges({ line: 1, col: 1 }, { line: 3, col: 2 }, lines);
  assert.deepEqual(a, b);
});

test("computeRectRanges 列超出行尾时被夹到行尾（允许空区间）", () => {
  // "hi"(9..11, 长度2) 取 col2..col9 -> 夹到 9..11
  const lines = doc(["hi"]);
  const r = computeRectRanges({ line: 1, col: 2 }, { line: 1, col: 9 }, lines);
  assert.deepEqual(r, [{ from: 2, to: 2 }]);
});

test("computeRectRanges 跨不存在行时忽略该行", () => {
  const lines = doc(["a", "b"]);
  const r = computeRectRanges({ line: 1, col: 0 }, { line: 5, col: 1 }, lines);
  assert.equal(r.length, 2);
  assert.deepEqual(r, [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ]);
});

// ---------------- markdown 预览 ----------------
test("isMarkdownDoc 按扩展名识别（大小写不敏感）", () => {
  assert.equal(isMarkdownDoc("a.md"), true);
  assert.equal(isMarkdownDoc("a.MARKDOWN"), true);
  assert.equal(isMarkdownDoc("a.mdown"), true);
  assert.equal(isMarkdownDoc("a.txt"), false);
  assert.equal(isMarkdownDoc("a"), false);
  assert.equal(isMarkdownDoc(undefined, "笔记.md"), true);
});

test("renderMarkdown 渲染常见语法", () => {
  const h = renderMarkdown("# 标题\n\n正文 **加粗** 与 `代码`。\n\n- 列表项");
  assert.match(h, /<h1[^>]*>标题<\/h1>/);
  assert.match(h, /<strong>加粗<\/strong>/);
  assert.match(h, /<code>代码<\/code>/);
  assert.match(h, /<li>列表项<\/li>/);
});

test("renderMarkdown 代码围栏生成 pre/code", () => {
  const h = renderMarkdown("```js\nconst x = 1;\n```");
  assert.match(h, /<pre>/);
  assert.match(h, /<code/);
});

test("renderMarkdown 净化脚本与事件属性", () => {
  const h = renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(2)> [x](javascript:evil)");
  assert.ok(!/script/i.test(h), "脚本应被移除: " + h);
  assert.ok(!/onerror/i.test(h), "事件属性应被移除: " + h);
  assert.ok(!/javascript:/i.test(h), "javascript: 协议应被移除: " + h);
});

// ---------------- 文本转换工具箱 ----------------
test("base64 编解码可逆（含中文/UTF-8）", () => {
  const s = "Hello, 世界 🌍";
  assert.equal(base64Decode(base64Encode(s)), s);
});

test("url 编解码可逆", () => {
  const s = "a b&c?d=1#片段";
  assert.equal(urlDecode(urlEncode(s)), s);
});

test("html 实体编解码可逆（& < > \" '）", () => {
  const s = `a & b < c > "d" 'e'`;
  assert.equal(htmlDecode(htmlEncode(s)), s);
  assert.equal(htmlEncode(`<b>`), "&lt;b&gt;");
});

test("ascii/hex 编解码可逆", () => {
  const s = "AB\nZ";
  assert.equal(toHex(s), "41 42 0A 5A");
  assert.equal(fromHex(toHex(s)), s);
});
test("fromHex 非法输入报错", () => {
  assert.throws(() => fromHex("zz"));
});

test("dedupLines 保留首次出现", () => {
  assert.equal(dedupLines("a\nb\na\nc\nb"), "a\nb\nc");
});
test("removeBlankLines 删除空行与纯空白行", () => {
  assert.equal(removeBlankLines("a\n\n  \nb\n"), "a\nb");
});
test("trimLeading 去除行首空白", () => {
  assert.equal(trimLeading("  x\n\t y"), "x\ny");
});
test("sortLines 升序/降序", () => {
  assert.equal(sortLines("c\n a\nb", false), " a\nb\nc");
  assert.equal(sortLines("c\n a\nb", true), "c\nb\n a");
});
test("reverseLines 反转行顺序", () => {
  assert.equal(reverseLines("1\n2\n3"), "3\n2\n1");
});

test("全角→半角 转换标点/数字/字母/空格", () => {
  assert.equal(toHalfWidth("ＡＢＣ１２３　！？："), "ABC123 !?:"); // 全角空格→半角空格
});
test("半角→全角 可逆（ASCII 可打印区）", () => {
  assert.equal(toFullWidth(toHalfWidth("Test 123!")), "Ｔｅｓｔ　１２３！");
});
test("全角/半角 对中文不加改变", () => {
  assert.equal(toHalfWidth("中文ＡＢ"), "中文AB");
  assert.equal(toFullWidth("中文ab"), "中文ａｂ");
});

test("unicodeNormalize NFC/NFD/NFKC/NFKD 工作", () => {
  const s = "é"; // 单码点
  const decomposed = unicodeNormalize(s, "NFD"); // e + 组合记号
  assert.equal(unicodeNormalize(decomposed, "NFC"), s);
  const full = "①"; // 全角圈数字
  assert.equal(unicodeNormalize(full, "NFKC"), "1");
  assert.equal(unicodeNormalize(full, "NFKD"), "1");
});

