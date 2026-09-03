import { EditorView } from "@codemirror/view";
import { t } from "./i18n";

const COMMON = `the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us are was were been being has had did done said went going got made knew took came saw thought looked could would should may might must shall will used work worked put place right left good bad great little large full half early late near far open close start stop turn move walk run jump sit stand rise fall live die laugh cry sleep wake eat drink talk tell hear listen read write sing play win lose love hate fear hope trust learn teach help serve give keep hold carry bring send push pull lift drop catch throw break fix build grow plant paint draw create change stay remain leave enter return arrive travel stay live work rest ask answer choose decide wish want need consider reason judge believe plan agree disagree argue debate explain describe mention note suggest advise warn promise remind guarantee admit reveal cover defend protect prevent begin close shut lock unlock connect join unite divide combine mix cook bake boil grill slice chop wash clean dry fold hang arrange design paint polish repair maintain reserve save guard watch observe notice inspect study research analyze review estimate calculate count measure compare distinguish identify classify organize sort filter select promote reduce increase decrease grow shrink expand extend narrow straighten bend twist turn rotate begin adjust modify change transform convert translate interpret clarify simplify complicate solve result cause reason purpose aim goal target standard model system structure framework method technique strategy approach process procedure program plan sketch draft compose develop improve refine perfect complete finish conclude summarize shorten lengthen move remain need include contain occur happen arise appear seem sound feel look resemble represent symbolize embody illustrate depict narrate relate inform notify advise consult confer discuss communicate interact share contribute provide supply prepare arrange coordinate cooperate partner ally unite merge integrate connect attach fasten tie secure anchor land touch reach cover hold include involve entail comprise feature add append continue resume pause stop halt delay advance progress proceed lead guide direct navigate place set fix adapt adjust alter exchange change shift replace substitute convert translate interpret decode encode communicate signal announce declare state claim assert affirm deny reject accept approve permit allow forbid ban prohibit restrict limit control manage direct command order request demand require insist suggest propose recommend urge encourage persuade convince motivate inspire support assist aid benefit enhance elevate augment strengthen empower enable authorize sanction endorse advocate champion defend justify warrant merit earn gain obtain acquire secure attain achieve fulfill execute perform complete realize materialize occur happen take place emerge arise appear seem look turn out prove demonstrate exhibit display show reveal expose uncover disclose divulge impart share bestow confer grant award donate contribute to provide offer present extend give lend loan rent sell buy purchase obtain acquire get receive accept take adopt assume undertake shoulder bear tolerate endure withstand resist oppose defy challenge confront face meet greet welcome host entertain divert amuse please delight charm attract appeal fascinate interest engage engross absorb involve immerse preoccupy occupy busy occupy engage burden encumber hamper obstruct impede hinder block bar close obstruct prevent avoid evade dodge shirk dodge elude escape bypass detour divert sidetrack distract confuse bewilder perplex baffle puzzle mystify confuse confound dumbfound stagger astonish amaze astound surprise startle alarm frighten scare terrify horrify shock stun stupefy paralyze immobilize freeze halt stop cease quit abandon desert forsake relinquish yield surrender submit defer concede grant allow concede recognize admit confess acknowledge own embrace accept adopt receive welcome entertain embrace hug cuddle snuggle nestle nuzzle kiss lick sip drink swallow gulp devour consume eat munch nibble chew bite gnaw crunch masticate ingest digest absorb assimilate incorporate integrate meld blend merge fuse coalesce unite amalgamate combine consolidate merge mix blend intermingle commingle mingle intermix intertwine interweave weave lace knit mesh trace spin loop braid plait interlace lace fuse blend temper alloy contaminate pollute taint corrupt degrade spoil rot decay decompose disintegrate crumble fall apart breakdown collapse crash fail malfunction error glitch bug defect flaw imperfection blemish mark stain smear spill splatter splash sprinkle scatter disperse dissipate dispel dissolve evaporate vanish disappear recede recede retreat withdraw retire step back fall back retreat move back pull back cede concede yield give up hand over transfer convey deliver pass give hand grant assign allocate appropriate set aside reserve keep retain hold preserve protect conserve save maintain sustain uphold support back buttress bolster reinforce strengthen prop bolster sustain maintain support hold carry bear endure tolerate undergo experience go through endure withstand weather survive endure suffer bear tolerate withstand weather survive live through experience face encounter meet come across run into bump into stumble upon chance upon happen upon encounter meet confront face address tackle handle deal with manage cope with contend with battle struggle fight combat oppose withstand resist endure bear tolerate weather survive last endure continue persist persevere carry on go on keep on proceed continue carry forward advance progress proceed move forward forge ahead quick normal words maybe identifier sentence paragraph character letter number line column row table list item section chapter note comment example test code string array object function class method property value input output result field index length count total amount number quantity size type kind sort order level grade score point mark sign signal symbol token name title header footer body content text page document file folder directory path root device screen window view mode edit view file open save close find replace insert delete undo redo copy paste cut select move scroll resize minimize maximize restore quit exit cancel approve confirm apply reset clear empty blank break continue skip pause stop start finish begin end start again repeat once second minute hour day week month year today tomorrow yesterday.`;
const COMMON_SET = new Set<string>();

for (const w of COMMON.split(/\s+/)) if (w) COMMON_SET.add(w.toLowerCase());

const USER_KEY = "uec.spell.user";
function userWords(): Set<string> {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}
export function addUserWord(w: string) {
  const u = userWords();
  u.add(w.toLowerCase());
  try {
    localStorage.setItem(USER_KEY, JSON.stringify([...u]));
  } catch {
    /* ignore */
  }
}
export function clearUserWords() {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

function looksIdentifier(w: string): boolean {
  // 大写/数字/下划线/引号/混合大小写 → 视为代码标识符，跳过
  if (/[A-Z0-9_'"()\\.\\-\\[\\]]/.test(w)) return true;
  return false;
}

export function scanUnknown(text: string): Array<{ word: string; count: number }> {
  const users = userWords();
  const cnt = new Map<string, number>();
  const re = /[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length < 3) continue;
    if (looksIdentifier(m[0])) continue;
    if (COMMON_SET.has(w) || users.has(w)) continue;
    cnt.set(w, (cnt.get(w) ?? 0) + 1);
  }
  return [...cnt.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 300);
}

export function spellCheckDialog(view: EditorView, doReplace: (word: string, replacement: string) => void) {
  const text = view.state.doc.toString();
  const unknown = scanUnknown(text);
  const modal = document.createElement("div");
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal" style="min-width:460px;max-height:80vh;display:flex;flex-direction:column;">
      <div class="modal-title">${t("拼写检查（共 {n} 个未收录词）", { n: unknown.length })}</div>
      <div class="rec-list" id="sp-list" style="flex:1;"></div>
      <div class="modal-actions" style="margin-top:10px;">
        <button data-alladd class="primary">${t("全部加入词典")}</button>
        <button data-close>${t("关闭")}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const list = modal.querySelector<HTMLElement>("#sp-list")!;
  const frag = document.createDocumentFragment();
  for (const u of unknown) {
    const row = document.createElement("div");
    row.className = "sp-row";
    const w = document.createElement("span");
    w.className = "sp-word";
    w.textContent = u.word;
    const meta = document.createElement("span");
    meta.className = "rec-meta";
    meta.textContent = `${u.count} ${t("次")}`;
    const btns = document.createElement("span");
    btns.className = "rec-btns";
    const add = document.createElement("button");
    add.className = "search-btn";
    add.textContent = t("加入词典");
    const rep = document.createElement("button");
    rep.className = "search-btn";
    rep.textContent = t("替换…");
    btns.append(add, rep);
    row.append(w, meta, btns);
    add.addEventListener("click", () => {
      addUserWord(u.word);
      row.remove();
    });
    rep.addEventListener("click", () => {
      const replacement = window.prompt(t('将 "{word}" 替换为：', { word: u.word }), u.word);
      if (replacement && replacement !== u.word) {
        doReplace(u.word, replacement);
        row.remove();
      }
    });
    frag.appendChild(row);
  }
  list.appendChild(frag);
  modal.querySelector("[data-alladd]")!.addEventListener("click", () => {
    for (const u of unknown) addUserWord(u.word);
    list.innerHTML = "";
    modal.querySelector(".modal-title")!.textContent = t("已全部加入用户词典");
  });
  modal.querySelector("[data-close]")!.addEventListener("click", () => modal.remove());
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.remove();
  });
}