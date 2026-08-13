/* ============================================================
   ミッドナイトライン ― コア
   DOM に一切触れない部分：状態・フラグ・条件評価・パラメータ・
   ノードの状態変更・制御フロー解決・エンディング判定。

   ここに置いたものは engine.js（ブラウザ）と tools/check.mjs（Node）の
   両方から同じ実装として使われる。検証スクリプトが本番と違う挙動を
   再実装してしまわないようにするための分離。
   ============================================================ */

const CHARS = {
  LEN:{name:'レニィ',sub:'男子学生・青い髪',col:'#7fa8ff'},
  HYU:{name:'ヒュウ',sub:'男子学生・緑の髪',col:'#7fd3a0'},
  JIN:{name:'ジンパチ',sub:'男子学生・茶髪',col:'#f0a05a'},
  MUN:{name:'ムニ',sub:'5歳・青い髪',col:'#9ec9ff'},
  GER:{name:'ゲル',sub:'女性・紫の髪',col:'#c08adf'},
  NEO:{name:'ネオ',sub:'???',col:'#f0d878'},
  KAI:{name:'灰堂帰一',sub:'医師',col:'#a0a8b4'},
  MRI:{name:'室井',sub:'前任相談員',col:'#a0a8b4'},
  CAN:{name:'カナタ',sub:'ジンパチの親友',col:'#a0a8b4'},
  UNK:{name:'???',sub:'発信者不明',col:'#c4443a'},
  ME :{name:'あなた',sub:'夜間相談員',col:'#7fb6c9'}
};
const TRACKED = ['LEN','HYU','JIN','MUN','GER','NEO'];

/* ---------- 状態 ----------
   S = 周回内の状態（セーブ対象） / G = 周回を跨ぐ状態 */
let S, G;

/* UI 側フック。engine.js が実装を差し込む。
   Node での検証時は既定の no-op のまま使う。 */
const Hooks = {
  par(){}, meet(){}, memo(){}, evd(){}, vm(){}, rec(){}, tlfix(){}, toastx(){}
};

function newChar(){ return {trust:20,doubt:0,fear:0,stress:0,state:'安定',life:'生存',known:[]}; }
function newState(loopCarry){
  const c = {}; TRACKED.forEach(k => c[k] = newChar());
  return {
    loop: loopCarry ? loopCarry.loops + 1 : 1,
    day:1, chapter:'pro', chapTitle:'序章 もしもし、きこえますか',
    clock:22*60, flags:{}, chars:c, noise:0,
    memo:[], evd:[], tl:[
      {d:'10年前 8/14',t:'児童養護施設「灯守園」で火災。園児1名が死亡、職員1名が放火犯として服役。'},
      {d:'　　　　　　',t:'（　　　　　　　　　　　　　　　）'},
      {d:'2週間前',t:'市内で若者の失踪が相次ぐ。'}
    ],
    rel:[], vm:[], hist:[], recs:[], stills:[], cur:null, callStart:null
  };
}
function setState(s){ S = s; }
function setGlobal(g){ G = g; }

const F  = k => !!S.flags[k];
const SET= (k,v=1) => { S.flags[k]=v; };
const CNT= k => S.flags[k]|0;

function clockStr(m){ m = ((m%1440)+1440)%1440; return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); }

/* ---------- 条件評価 ----------
   上から最初に一致したキーだけを見て返す（複数キー併記は先勝ち）。 */
function cond(c){
  if(!c) return true;
  if(c.and) return c.and.every(cond);
  if(c.or)  return c.or.some(cond);
  if(c.f)   return F(c.f);
  if(c.nf)  return !F(c.nf);
  if(c.cnt) return CNT(c.cnt[0]) >= c.cnt[1];
  if(c.tr)  return S.chars[c.tr[0]].trust >= c.tr[1];
  if(c.dbt) return S.chars[c.dbt[0]].doubt >= c.dbt[1];
  if(c.alive) return S.chars[c.alive].life === '生存';
  if(c.loop)  return S.loop >= c.loop;
  if(c.recs)  return (G.recs||[]).length >= c.recs;      // 裏を暴いた録音の累計（周回跨ぎ）
  if(c.cleared) return (G.endings||[]).includes(c.cleared); // 到達済みエンディング（周回跨ぎ）
  return true;
}

/* ---------- パラメータ ---------- */
function applyPar(p){
  const c = S.chars[p.c]; if(!c) return;
  ['trust','doubt','fear','stress'].forEach(k=>{ if(p[k]!=null) c[k] = Math.max(0,Math.min(100,c[k]+p[k])); });
  const f = c.fear, st = c.stress;
  c.state = (c.life!=='生存') ? c.life : (f>75||st>85 ? '危機' : f>50||st>60 ? '混乱' : f>25||st>35 ? '動揺' : '安定');
  Hooks.par();
}

/* ---------- ノードの状態変更 ----------
   exec() のうち DOM に触れない部分。engine.js と check.mjs の共通実装。
   キーの評価順は元実装の exec() と同一。 */
function applyData(nd){
  if(nd.set){ Object.entries(nd.set).forEach(([k,v])=>SET(k,v)); }
  if(nd.inc){ Object.entries(nd.inc).forEach(([k,v])=>SET(k, CNT(k)+v)); }
  if(nd.par){ applyPar(nd.par); }
  // meet / know は TRACKED 外のキャラ（灰堂・室井など）にも使われる。
  // その場合パラメータの器が無いので、フラグだけ立てて器の操作は飛ばす。
  if(nd.meet){ SET('MET_'+nd.meet); const c = S.chars[nd.meet]; if(c) c.known = nd.known||[]; Hooks.meet(); }
  if(nd.know){ const c = S.chars[nd.know[0]]; if(c && !c.known.includes(nd.know[1])) c.known.push(nd.know[1]); }
  if(nd.life){ S.chars[nd.life[0]].life = nd.life[1]; applyPar({c:nd.life[0]}); }
  if(nd.memo){ S.memo.push({d:S.day, t:nd.memo[0], x:nd.memo[1]}); Hooks.memo(nd.memo[0]); }
  if(nd.evd){ S.evd.push({t:nd.evd[0], x:nd.evd[1]}); Hooks.evd(nd.evd[0]); }
  if(nd.tl){ S.tl.push({d:nd.tl[0], t:nd.tl[1]}); }
  if(nd.tlfix){ const e = S.tl[1]; e.d = nd.tlfix[0]; e.t = nd.tlfix[1]; Hooks.tlfix(); }
  if(nd.rel){ S.rel.push({a:nd.rel[0], t:nd.rel[1], b:nd.rel[2], dot:nd.rel[3]}); }
  if(nd.vm){ S.vm.push({d:S.day, c:clockStr(S.clock), w:nd.vm[0], x:nd.vm[1]}); Hooks.vm(); }
  if(nd.rec){ S.recs.push({id:nd.rec.id, day:S.day, ti:nd.rec.ti, tx:nd.rec.tx, hid:nd.rec.hid, flag:nd.rec.flag,
      opened:(G.recs||[]).includes(nd.rec.id)?1:0}); Hooks.rec(); }
  if(nd.toastx){ Hooks.toastx(); }
}

/* 時刻・日付の変更（DOM 更新は呼び出し側の責務） */
function applyTime(nd){
  if(nd.clock){ const [h,m] = nd.clock.split(':').map(Number); S.clock = h*60+m; }
  if(nd.day){ S.day = nd.day; S.clock = 22*60; }
}

/* ---------- 選択肢の状態変更 ---------- */
function applyChoice(o){
  S.clock += o.cost || 2;
  if(o.eff) Object.entries(o.eff).forEach(([k,v])=>{
    const [c,p] = k.split('.'); applyPar({c, [p]: v});
  });
  if(o.set) Object.entries(o.set).forEach(([k,v])=>SET(k,v));
  if(o.inc) Object.entries(o.inc).forEach(([k,v])=>SET(k, CNT(k)+v));
  if(o.memo) S.memo.push({d:S.day,t:o.memo[0],x:o.memo[1]});
}

/* 表示される選択肢（hide が不成立のものは存在しない） */
function visibleChoices(nd){ return nd.ch.filter(o => !o.hide || cond(o.hide)); }
/* 実際に押せる選択肢（req 不成立はロック表示される） */
function selectableChoices(nd){ return visibleChoices(nd).filter(o => cond(o.req)); }
/* 制限時間切れで自動選択されるもの */
function timeoutChoice(nd){
  const list = visibleChoices(nd);
  return nd.ch.find(o=>o.timeout) || list[list.length-1];
}

/* ---------- 制御フロー ----------
   go は if より先に評価される（元実装の順序を保存）。
   if が成立すれば go の行き先を上書きし、不成立で els が無ければ go のまま。
   戻り値: ジャンプ先ラベル名 / ジャンプ不要なら null */
function resolveJump(nd){
  let target = null;
  if(nd.go) target = nd.go;
  if(nd.if){
    if(cond(nd.if)) target = nd.go2 || nd.then;
    else if(nd.els) target = nd.els;
  }
  return target;
}

/* ---------- エンディング判定 ----------
   条件は design.md §6（エンディング表）と §12（TRUE/SECRET解放条件）に対応する。
   §12 の条件リストのほうが具体的なので、両者が食い違う場合は §12 を採る。 */
const REC_ALL = 7;   // 隠し録音の総数（r01〜r07）

function judge(){
  const alive = k => S.chars[k].life === '生存';
  // 「現在組」= 主人公が電話で関わる5名。ムニは十年前の人物なので含まない
  const MAIN = ['LEN','JIN','GER','HYU','NEO'];
  const allAlive = MAIN.every(alive);
  const mainAlive = MAIN.filter(alive).length;

  // GOOD: 灰堂逮捕 + 剛三冤罪証明 + 現在組全員生存
  const goodBase = F('KAI_EXPOSE_01') && F('GER_KNIFE_01') && F('JIN_RUSH_01') && alive('LEN');
  // TRUE (§12): ①刷り込み3点 ②ムニ回線の切電 ③全員生存 ④テープ+波形の照合 ⑤共闘 ⑥真相解放
  const trueCond = goodBase && allAlive
    && F('MUN_TEACH_01') && F('MUN_TEACH_02') && F('MUN_TEACH_03')
    && CNT('MUN_CUT_XX') < 2 && F('EVD_TAPE_01') && F('EVD_WAVE_01') && F('NEO_HYU_01') && F('STORY_TRUE_KEY');
  // SECRET (§12): TRUEクリア後の周回で隠し番号へ発信 + 隠し録音を全回収
  const secretCond = trueCond && F('SEC_CALL_01')
    && (G.recs||[]).length >= REC_ALL && (G.endings||[]).includes('TRUE');

  if(secretCond) return 'SECRET';
  if(trueCond) return 'TRUE';
  if(goodBase && allAlive) return 'GOOD';
  // BAD (§6): 主要生存者2名以下、または裂け目閉鎖失敗（＝街が地図から消える）
  if(mainAlive <= 2 || !F('RIFT_CLOSED')) return 'BAD';
  return 'NORMAL';
}
