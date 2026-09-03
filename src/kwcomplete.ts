import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

const KEYWORDS: Record<string, string[]> = {
  js: ["const","let","var","function","return","if","else","for","while","do","switch","case","break","continue","new","delete","typeof","instanceof","in","of","this","super","class","extends","import","from","export","default","async","await","try","catch","finally","throw","yield","get","set","static","private","public","protected","null","undefined","true","false","NaN","Infinity","globalThis","window","document","console","Math","JSON","Promise","Object","Array","String","Number","Boolean","RegExp","Set","Map","Date","Error","fetch","setTimeout","setInterval","querySelector","addEventListener"],
  py: ["def","class","return","if","elif","else","for","while","break","continue","pass","import","from","as","try","except","finally","raise","with","lambda","yield","global","nonlocal","None","True","False","self","print","range","len","str","int","float","list","dict","set","tuple","open","input","isinstance","super","assert","async","await"],
  rs: ["fn","let","mut","const","struct","enum","trait","impl","pub","mod","use","if","else","for","while","loop","match","break","continue","return","static","unsafe","async","await","move","ref","where","self","Self","crate","super","dyn","as","in","Vec","String","Option","Result","Box","println"],
  go: ["package","import","func","const","var","type","struct","interface","map","chan","go","defer","return","if","else","for","range","switch","case","break","continue","fallthrough","default","select","nil","true","false","make","len","cap","append","copy","error","fmt"],
  c: ["include","define","ifdef","endif","int","char","float","double","void","bool","true","false","null","this","class","public","private","protected","static","const","virtual","override","new","delete","switch","case","default","return","break","continue","for","while","do","if","else","using","namespace","std","printf","scanf","size_t","unsigned","long","short"],
  h: ["include","define","ifdef","endif","int","char","float","double","void","bool","true","false","null","const","static","size_t","unsigned","long","short","extern"],
  sh: ["if","then","else","fi","for","while","case","esac","function","echo","cd","ls","rm","mv","cp","cat","grep","sed","awk","exit","return","declare","export","readonly","local","select","do","done","read","test","printf","true","false","[[","]]"],
  java: ["public","private","protected","static","final","class","interface","extends","implements","import","package","new","return","if","else","for","while","do","switch","case","break","continue","try","catch","finally","throw","throws","this","super","void","int","long","double","float","boolean","char","byte","String","System","out","print","println","null","true","false","enum","abstract","volatile","synchronized"],
  cs: ["public","private","protected","internal","static","class","interface","namespace","using","new","return","if","else","for","foreach","while","switch","case","break","continue","try","catch","finally","throw","this","base","void","int","string","bool","var","null","true","false","enum","async","await","struct","readonly"],
  php: ["echo","print","if","else","elseif","for","foreach","while","switch","case","break","continue","return","function","class","extends","implements","interface","public","private","protected","static","new","try","catch","finally","throw","array","require","include","isset","empty","null","true","false","this","parent","namespace","use"],
  rb: ["def","end","class","module","if","elsif","else","unless","while","until","case","when","return","yield","break","next","redo","retry","begin","rescue","ensure","raise","attr_reader","attr_accessor","puts","print","gets","nil","true","false","self","require","include","new","each","map"],
  lua: ["function","end","if","then","elseif","else","for","while","repeat","until","return","break","local","nil","true","false","self","require","print","type","pairs","ipairs","table","string","math","#","do"],
  swift: ["func","let","var","if","else","guard","for","while","switch","case","break","return","class","struct","enum","protocol","import","public","private","internal","static","new","nil","true","false","self","try","catch","throw","async","await","String","Int","Double","Bool","Array","Dictionary","Set","print"],
  toml: ["table","false","true","string","integer","float"],
  sql: ["SELECT","FROM","WHERE","INSERT","INTO","VALUES","UPDATE","SET","DELETE","JOIN","LEFT","RIGHT","INNER","OUTER","ON","GROUP","BY","ORDER","HAVING","LIMIT","OFFSET","DISTINCT","AND","OR","NOT","NULL","COUNT","SUM","AVG","MAX","MIN","BEGIN","COMMIT","ROLLBACK","CREATE","TABLE","DROP","ALTER","index","UNIQUE","PRIMARY","KEY","FOREIGN","REFERENCES"],
};

const EXT_TO_KEY: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js",
  py: "py", pyw: "py", rs: "rs", c: "c", h: "h", cpp: "c", hpp: "c", cc: "c", cxx: "c",
  go: "go", sh: "sh", bash: "sh", zsh: "sh", java: "java", cs: "cs",
  php: "php", rb: "rb", lua: "lua", swift: "swift", sql: "sql", toml: "toml",
};

export function kwSourceFor(path: string) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const words = KEYWORDS[EXT_TO_KEY[ext] || ""] || [];
  return function kwSource(ctx: CompletionContext): CompletionResult | null {
    const word = ctx.matchBefore(/[\w]+/);
    if (!word || word.from === word.to) return null;
    const q = word.text.toLowerCase();
    const list: Completion[] = [];
    for (const w of words) {
      if (w.toLowerCase().startsWith(q)) {
        list.push({ label: w, type: "keyword", boost: 40 });
      }
    }
    if (!list.length) return null;
    return { from: word.from, options: list };
  };
}