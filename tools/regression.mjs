#!/usr/bin/env node
/* ============================================================
   回帰テスト

   過去に実際に発生した不具合を、症状の形でそのまま固定する。
   ここが落ちたら「直したはずのものが戻った」ということ。

   対象は core.js とシナリオデータで再現できるものに限る。
   engine.js 側（playRec / 周回ボタン / セーブ）の回帰は
   tools/playthrough.mjs が実ブラウザで検証する。

     node tools/regression.mjs
   ============================================================ */
import { loadApi, freshG } from './load-core.mjs';

const api = loadApi();
const { SCENARIO } = api;

let failures = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    failures++;
    results.push(['NG', name + '  → ' + e.message]);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}（実際: ${a} / 期待: ${b}）`); };

/** 検証用に素の状態を用意する */
function fresh(G = freshG(), loop = 1) {
  api.setGlobal(G);
  const S = api.newState(loop > 1 ? { loops: loop - 1 } : null);
  S.loop = loop;
  api.setState(S);
  return S;
}

/* ------------------------------------------------------------
   1. {meet:'KAI'} を通ってもクラッシュしない
   灰堂は TRACKED（パラメータを持つ6名）外なので S.chars['KAI'] が無い。
   かつて .known を代入して TypeError になり、第五章で進行が止まっていた。
   ------------------------------------------------------------ */
test("meet:'KAI' がクラッシュせず MET_KAI が立つ", () => {
  const S = fresh();
  api.applyData({ meet: 'KAI' });
  assert(api.F('MET_KAI'), 'MET_KAI が立っていない');
  assert(S.chars.KAI === undefined, 'TRACKED 外のキャラにパラメータの器を作ってはいけない');
});

test('TRACKED 外のキャラへの know も落ちない', () => {
  fresh();
  api.applyData({ know: ['KAI', 'テスト'] });   // 落ちなければよい
});

test('シナリオ中の全 meet / know ノードを実行しても落ちない', () => {
  fresh();
  let n = 0;
  for (const arr of Object.values(SCENARIO)) {
    for (const nd of arr) {
      if (nd.meet || nd.know) { api.applyData({ meet: nd.meet, known: nd.known, know: nd.know }); n++; }
    }
  }
  assert(n > 0, 'meet / know ノードが1件も見つからない');
});

/* ------------------------------------------------------------
   2. judge() が例外を出さない
   かつて allAlive が未定義で、goodBase 成立時だけ ReferenceError。
   短絡評価のため BAD/NORMAL では露見しなかった。
   ------------------------------------------------------------ */
test('judge() は goodBase 成立時でも例外を出さない', () => {
  fresh();
  ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01'].forEach(f => api.SET(f));
  const r = api.judge();
  assert(typeof r === 'string', 'judge() が文字列を返さない');
});

test('judge() は生死の全組み合わせで例外を出さない', () => {
  const MAIN = ['LEN', 'JIN', 'GER', 'HYU', 'NEO'];
  const LIVES = ['生存', '死亡', '消失'];
  for (let mask = 0; mask < 3 ** MAIN.length; mask++) {
    const S = fresh();
    ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'RIFT_CLOSED'].forEach(f => api.SET(f));
    let m = mask;
    for (const k of MAIN) { S.chars[k].life = LIVES[m % 3]; m = Math.floor(m / 3); }
    const r = api.judge();
    assert(['BAD', 'NORMAL', 'GOOD', 'TRUE', 'SECRET'].includes(r), `未知の判定結果 ${r}`);
  }
});

test('judge() は5種類すべてを返しうる（条件を直接組んだ場合）', () => {
  const TRUE_SET = ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'MUN_TEACH_01',
    'MUN_TEACH_02', 'MUN_TEACH_03', 'EVD_TAPE_01', 'EVD_WAVE_01', 'NEO_HYU_01',
    'STORY_TRUE_KEY', 'RIFT_CLOSED'];

  // BAD: 主要生存者が2名以下
  let S = fresh();
  ['JIN', 'GER', 'HYU'].forEach(k => S.chars[k].life = '消失');
  eq(api.judge(), 'BAD', 'BAD 判定');

  // BAD: 全員生きていても裂け目が閉じていない
  S = fresh();
  eq(api.judge(), 'BAD', '裂け目未閉鎖時の BAD 判定');

  // NORMAL: 裂け目は閉じたが真相は未解明
  S = fresh();
  api.SET('RIFT_CLOSED');
  eq(api.judge(), 'NORMAL', 'NORMAL 判定');

  // GOOD
  S = fresh();
  ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'RIFT_CLOSED'].forEach(f => api.SET(f));
  eq(api.judge(), 'GOOD', 'GOOD 判定');

  // TRUE
  S = fresh();
  TRUE_SET.forEach(f => api.SET(f));
  eq(api.judge(), 'TRUE', 'TRUE 判定');

  // SECRET: TRUE クリア済み + 隠し録音を全回収 + 隠し発信
  const G = freshG();
  G.endings = ['TRUE'];
  G.recs = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'];
  G.loops = 2;
  S = fresh(G, 3);
  TRUE_SET.forEach(f => api.SET(f));
  api.SET('SEC_CALL_01');
  eq(api.judge(), 'SECRET', 'SECRET 判定');
});

test('SECRET は隠し録音が欠けていると TRUE 止まりになる', () => {
  const G = freshG();
  G.endings = ['TRUE'];
  G.recs = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06'];   // 6件（1件足りない）
  G.loops = 2;
  fresh(G, 3);
  ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'MUN_TEACH_01', 'MUN_TEACH_02',
   'MUN_TEACH_03', 'EVD_TAPE_01', 'EVD_WAVE_01', 'NEO_HYU_01', 'STORY_TRUE_KEY',
   'RIFT_CLOSED', 'SEC_CALL_01'].forEach(f => api.SET(f));
  eq(api.judge(), 'TRUE', '録音が足りないのに SECRET になった');
});

test('SECRET は TRUE 未クリアだと TRUE 止まりになる', () => {
  const G = freshG();
  G.endings = ['GOOD'];
  G.recs = ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'];
  G.loops = 2;
  fresh(G, 3);
  ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'MUN_TEACH_01', 'MUN_TEACH_02',
   'MUN_TEACH_03', 'EVD_TAPE_01', 'EVD_WAVE_01', 'NEO_HYU_01', 'STORY_TRUE_KEY',
   'RIFT_CLOSED', 'SEC_CALL_01'].forEach(f => api.SET(f));
  eq(api.judge(), 'TRUE', 'TRUE 未クリアなのに SECRET になった');
});

test('ムニ回線を2回切ると TRUE が恒久的に封鎖される', () => {
  fresh();
  ['KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'MUN_TEACH_01', 'MUN_TEACH_02',
   'MUN_TEACH_03', 'EVD_TAPE_01', 'EVD_WAVE_01', 'NEO_HYU_01', 'STORY_TRUE_KEY',
   'RIFT_CLOSED'].forEach(f => api.SET(f));
  api.applyData({ inc: { MUN_CUT_XX: 2 } });
  eq(api.judge(), 'GOOD', 'MUN_CUT_XX=2 でも TRUE になった');
});

/* ------------------------------------------------------------
   3. 周回で残るもの / 消えるもの
   ------------------------------------------------------------ */
test('周回跨ぎ条件 recs / cleared が G を見る', () => {
  const G = freshG();
  G.recs = ['r01', 'r02'];
  G.endings = ['GOOD'];
  fresh(G, 2);
  assert(api.cond({ recs: 2 }), 'recs:2 が成立しない');
  assert(!api.cond({ recs: 3 }), 'recs:3 が誤って成立する');
  assert(api.cond({ cleared: 'GOOD' }), 'cleared:GOOD が成立しない');
  assert(!api.cond({ cleared: 'TRUE' }), 'cleared:TRUE が誤って成立する');
});

test('周回してもフラグと信頼度はリセットされる', () => {
  const G = freshG();
  G.loops = 1;
  G.endings = ['GOOD'];
  const S = fresh(G, 2);
  eq(Object.keys(S.flags).length, 0, '周回開始時にフラグが残っている');
  eq(S.chars.LEN.trust, 20, '周回開始時に信頼度が初期値でない');
  eq(S.chars.LEN.life, '生存', '周回開始時に生死が初期値でない');
});

test('2周目の隠し選択肢が loop 条件で開く', () => {
  // 序章の隠し発信（SEC_CALL_01）
  const node = SCENARIO.pro.find(n => n.ch && n.ch.some(o => o.set && o.set.SEC_CALL_01));
  assert(node, '隠し発信の選択肢ノードが見つからない');

  fresh(freshG(), 1);
  eq(api.visibleChoices(node).some(o => o.set && o.set.SEC_CALL_01), false, '1周目で隠し選択肢が見えている');

  const G = freshG(); G.loops = 1;
  fresh(G, 2);
  eq(api.visibleChoices(node).some(o => o.set && o.set.SEC_CALL_01), true, '2周目で隠し選択肢が見えない');
});

test('終章の物置の鍵（MUN_TEACH_02）は2周目かつテープ所持で開く', () => {
  const node = SCENARIO.fin.find(n => n.ch && n.ch.some(o => o.set && o.set.MUN_TEACH_02));
  assert(node, 'MUN_TEACH_02 の選択肢ノードが見つからない');
  const has = () => api.visibleChoices(node).some(o => o.set && o.set.MUN_TEACH_02);

  fresh(freshG(), 1); api.SET('EVD_TAPE_01');
  eq(has(), false, '1周目で見えてしまっている');

  const G = freshG(); G.loops = 1;
  fresh(G, 2);
  eq(has(), false, 'テープ未所持で見えてしまっている');
  api.SET('EVD_TAPE_01');
  eq(has(), true, '2周目かつテープ所持で見えない');
});

/* ------------------------------------------------------------
   4. 制限時間（sec）
   シナリオは {sec:n} を選択肢ノードの手前に独立したノードとして置く。
   engine.js が nd.sec を選択肢ノード上でしか見ていなかったため、
   制限時間バーも timeout:1 の自動選択も一度も発火していなかった。
   ------------------------------------------------------------ */
test('{sec:n} は必ず選択肢ノードの直前に置かれている', () => {
  let n = 0;
  for (const [ch, arr] of Object.entries(SCENARIO)) {
    arr.forEach((nd, i) => {
      if (nd.sec == null || nd.ch || nd.multi) return;   // multi は sec を自前で持つ
      n++;
      const next = arr[i + 1];
      assert(next && next.ch, `${ch}[${i}] の {sec:${nd.sec}} の直後が選択肢ノードでない`);
    });
  }
  assert(n > 0, '独立した {sec} ノードが1件も無い');
});

test('制限時間つきの選択肢には timeout:1 が用意されている', () => {
  for (const [ch, arr] of Object.entries(SCENARIO)) {
    arr.forEach((nd, i) => {
      if (!nd.ch) return;
      const sec = nd.sec != null ? nd.sec : (arr[i - 1] && arr[i - 1].sec);
      if (!sec) return;
      assert(nd.ch.some(o => o.timeout), `${ch}[${i}] は sec:${sec} だが timeout:1 が無い`);
    });
  }
});

test('制限時間の無い選択肢には無条件で押せるものが必ずある', () => {
  for (const [ch, arr] of Object.entries(SCENARIO)) {
    arr.forEach((nd, i) => {
      if (!nd.ch) return;
      const sec = nd.sec != null ? nd.sec : (arr[i - 1] && arr[i - 1].sec);
      if (sec) return;
      assert(nd.ch.some(o => !o.req && !o.hide),
        `${ch}[${i}] は全選択肢が req / hide つきで、条件を満たさないと進行不能`);
    });
  }
});

/* ------------------------------------------------------------
   5. exec の評価順に関する不変条件
   ------------------------------------------------------------ */
test('go は if より先に評価され、if が成立すれば上書きする', () => {
  fresh();
  eq(api.resolveJump({ go: 'A' }), 'A', 'go 単独');
  eq(api.resolveJump({ if: { f: 'X' }, then: 'B', els: 'C' }), 'C', 'if 不成立で els');
  api.SET('X');
  eq(api.resolveJump({ if: { f: 'X' }, then: 'B', els: 'C' }), 'B', 'if 成立で then');
  eq(api.resolveJump({}), null, 'ジャンプ不要なノード');
});

test('life が 生存 以外になると精神状態表示を上書きする', () => {
  const S = fresh();
  api.applyData({ life: ['HYU', '消失'] });
  eq(S.chars.HYU.state, '消失', 'state が life を反映しない');
});

test('パラメータは 0〜100 にクランプされる', () => {
  const S = fresh();
  api.applyPar({ c: 'LEN', trust: 999 });
  eq(S.chars.LEN.trust, 100, '上限クランプ');
  api.applyPar({ c: 'LEN', trust: -999 });
  eq(S.chars.LEN.trust, 0, '下限クランプ');
});

test('tlfix は事件年表の空白行（index 1）だけを書き換える', () => {
  const S = fresh();
  const before = S.tl.length;
  api.applyData({ tlfix: ['10年前 8/14', 'テスト'] });
  eq(S.tl.length, before, '年表の行数が変わった');
  eq(S.tl[1].t, 'テスト', '空白行が書き換わっていない');
});

/* ------------------------------------------------------------
   序章レニィの第一声は周回で差し替わる（design §10 鳥肌演出10）
   1周目は通常、2周目以降は「前にも話したこと、あるよね?」。
   ------------------------------------------------------------ */
test('序章レニィの第一声が2周目以降で既視感版に差し替わる', () => {
  fresh(freshG(), 1);
  eq(api.cond({ loop: 2 }), false, '1周目で既視感版が出てしまう');
  fresh({ ...freshG(), loops: 1 }, 2);
  eq(api.cond({ loop: 2 }), true, '2周目で既視感版に切り替わらない');

  const pro = api.SCENARIO.pro;
  const at = l => pro.findIndex(n => n.n === l);
  assert(at('len_call_1') >= 0 && at('len_call_2') >= 0, '分岐先ラベルが無い');
  const sw = pro.find(n => n.if && n.then === 'len_call_2' && n.els === 'len_call_1');
  assert(sw && sw.if.loop === 2, 'len_call の周回分岐が {loop:2} になっていない');
  const dj = pro.slice(at('len_call_2')).find(n => n.say && n.say.includes('前にも話したこと'));
  assert(dj, '2周目の第一声に設計の台詞が無い');
});

/* ------------------------------------------------------------
   四章 neo_sync は、どの選択肢を選んでもネオが同じ言葉を返す
   （design §10 鳥肌演出4「選択肢テキストとネオの声のシンクロ」）
   ------------------------------------------------------------ */
test('四章 neo_sync はどの選択肢でもネオが同一文言を同時に発する', () => {
  const ch4 = api.SCENARIO.ch4;
  const at = l => ch4.findIndex(n => n.n === l);
  const chNode = ch4.slice(at('neo_sync')).find(n => n.ch);
  assert(chNode, 'neo_sync に選択肢が無い');
  eq(chNode.ch.length, 3, '選択肢が3つでない');
  for (const opt of chNode.ch) {
    const i = at(opt.go);
    assert(i >= 0, `分岐先 ${opt.go} が無い`);
    const line = ch4.slice(i).find(n => n.say);
    assert(line, `${opt.go} にネオの台詞が無い`);
    eq(line.c, 'NEO', `${opt.go} の話者がネオでない`);
    eq(line.say.replace(/。$/, ''), opt.t, `${opt.go} の台詞が選択肢テキストと一致しない`);
  }
});

/* ------------------------------------------------------------
   追補 §1-2 疑念の閾値：超えると決定的な情報が出てこない
   ------------------------------------------------------------ */
test('疑念40でジンパチはレコーダーを渡さない（EVD_KAI_STEP2 が失われる）', () => {
  const gate = api.SCENARIO.ch2.find(n => n.if && n.then === 'jin_tape_refuse');
  assert(gate, 'jin_tape の疑念ゲートが無い');
  const S = fresh();
  S.chars.JIN.doubt = 39; eq(api.cond(gate.if), false, '39 で塞がってしまう');
  S.chars.JIN.doubt = 40; eq(api.cond(gate.if), true, '40 で塞がらない');
  // 迂回して録音に辿り着けないこと＝失われる情報の確認
  const ch2 = api.SCENARIO.ch2;
  const refuse = ch2.findIndex(n => n.n === 'jin_tape_refuse');
  const seg = ch2.slice(refuse, ch2.findIndex((n,i) => i > refuse && n.n === 'jin_end'));
  assert(!seg.some(n => n.rec), '拒否ルートで録音が手に入ってしまう');
});

test('疑念35でヒュウは右目を語らない（HYU_EYE_01 が立たない）', () => {
  const gate = api.SCENARIO.ch3.find(n => n.if && n.then === 'hyu_eye_hide');
  assert(gate, 'hyu_eye の疑念ゲートが無い');
  const S = fresh();
  S.chars.HYU.doubt = 34; eq(api.cond(gate.if), false, '34 で塞がってしまう');
  S.chars.HYU.doubt = 35; eq(api.cond(gate.if), true, '35 で塞がらない');
  const ch3 = api.SCENARIO.ch3;
  const i = ch3.findIndex(n => n.n === 'hyu_eye_hide');
  const seg = ch3.slice(i, i + 20);
  assert(!seg.some(n => n.set && n.set.HYU_EYE_01), '拒否ルートで HYU_EYE_01 が立つ');
});

test('疑念40でゲルは灰堂を伏せる。回復イベントは一度きり', () => {
  const gate = api.SCENARIO.ch5.find(n => n.if && n.then === 'ger_c3_hide');
  assert(gate, 'ger_c3 の疑念ゲートが無い');
  const S = fresh();
  S.chars.GER.doubt = 40;
  eq(api.cond(gate.if), true, '40 で塞がらない');
  api.SET('GER_HIDE_SEEN');
  eq(api.cond(gate.if), false, '二度目も分岐して無限ループになる');
  // 回復選択肢は疑念を閾値未満まで落とせる量を持つ
  const hide = api.SCENARIO.ch5;
  const chNode = hide.slice(hide.findIndex(n => n.n === 'ger_c3_hide')).find(n => n.ch);
  const rec = chNode.ch.find(o => o.eff && o.eff['GER.doubt'] <= -25);
  assert(rec, '回復選択肢の疑念減少が -25 未満');
});

test('疑念30でムニは終章の指示を受け取れず、回復選択肢だけが現れる', () => {
  const fin = api.SCENARIO.fin;
  const teach = fin.filter(n => n.ch).flatMap(n => n.ch)
    .filter(o => o.req && JSON.stringify(o.req).includes('FIN_LOW'));
  assert(teach.length >= 2, '終章の教える選択肢が見つからない');
  for (const o of teach) assert(JSON.stringify(o.req).includes('ndbt'), '疑念ロックが掛かっていない');

  const S = fresh();
  api.SET('MUN_TEACH_01');
  const node = fin.find(n => n.ch && n.ch.some(o => o.go === 'fin_t1'));
  S.chars.MUN.doubt = 30;
  const low = node.ch.find(o => o.go === 'fin_t1');
  eq(api.cond(low.req), false, '疑念30でも教えられてしまう');
  S.chars.MUN.doubt = 29;
  eq(api.cond(low.req), true, '疑念29で教えられない');

  const rec = node.ch.find(o => o.go === 'fin_recover');
  assert(rec, 'ムニの回復選択肢が無い');
  S.chars.MUN.doubt = 30;
  eq(api.cond(rec.hide), true, '疑念30で回復選択肢が出ない');
  S.chars.MUN.doubt = 10;
  eq(api.cond(rec.hide), false, '疑念が低いのに回復選択肢が出る');
  eq(rec.eff['MUN.doubt'], -45, '回復量が設計値と違う');
});

/* ------------------------------------------------------------
   追補 §5 留守番電話は二晩で上書きされる
   ------------------------------------------------------------ */
test('留守電は二晩で上書きされ、VM_MISS と発信者への代償が入る', () => {
  const S = fresh();
  api.applyData({ vm: ['テスト', '本文', 'jin_first', 'JIN', { c: 'JIN', trust: -12, doubt: 20 }] });
  const before = S.chars.JIN.trust;
  S.day = 1; eq(api.expireVM(), 0, '当夜に消えた');
  S.day = 2; eq(api.expireVM(), 0, '翌夜に消えた');
  S.day = 3; eq(api.expireVM(), 1, '三晩目に消えない');
  eq(api.CNT('VM_MISS'), 1, 'VM_MISS が増えない');
  eq(api.F('VM_LOST_jin_first'), true, 'VM_LOST_ が立たない');
  eq(S.chars.JIN.trust, before - 12, '上書きの代償が入っていない');
  eq(api.expireVM(), 0, '同じメッセージで二重に減点される');
});

test('再生済みの留守電は上書きされない', () => {
  const S = fresh();
  api.applyData({ vm: ['テスト', '本文', 'k', 'JIN', { c: 'JIN', trust: -99 }] });
  S.vm[0].played = 1;
  S.day = 5;
  eq(api.expireVM(), 0, '再生済みが消えた');
  eq(api.CNT('VM_MISS'), 0, '再生済みで VM_MISS が増えた');
});

/* ------------------------------------------------------------
   追補 §6 通話時間・疲労・保留
   ------------------------------------------------------------ */
test('勤務時間は360分。超過すると疲労が1段ずつ増え、制限時間が短くなる', () => {
  const S = fresh();
  eq(api.timeLeft(), 360, '初期の残り時間が360分でない');
  eq(api.realSec(20), 20, '疲労0で制限時間が変わる');
  S.clock = api.SHIFT_END;
  eq(api.checkShift(), true, '超過を検出しない');
  eq(api.checkShift(), false, '同じ夜に二重加算される');
  eq(api.fatigue(), 1, '疲労が増えていない');
  eq(api.realSec(20), 18, '制限時間が12%短縮されない');
  S.flags.OVERTIME = 9;
  eq(api.fatigue(), 4, '疲労が4段で頭打ちにならない');
});

test('保留は待たせた分数に比例して相手を削る', () => {
  const S = fresh();
  S.clock = 22 * 60;
  api.holdLine('HYU');
  S.clock += 10;
  const min = api.resumeLine();
  eq(min, 10, '保留分数が違う');
  eq(S.chars.HYU.fear, 12, '恐怖 1.2/分 になっていない');
  eq(S.chars.HYU.stress, 9, 'ストレス 0.9/分 になっていない');
  eq(S.chars.HYU.trust, 20 - 3, '信頼 -0.3/分 になっていない');
  eq(S.held, null, '保留が解除されていない');
});

/* ------------------------------------------------------------
   追補 §2 メモの札
   ------------------------------------------------------------ */
test('メモの札は MB_/MD_ になり、同じ札をもう一度押すと保留に戻る', () => {
  const S = fresh();
  api.applyData({ memo: ['雨', '降っていない雨', 'rain'] });
  const m = S.memo[S.memo.length - 1];
  api.markMemo(m, 'b');
  eq(api.cond({ mb: 'rain' }), true, '〈信じる〉が立たない');
  api.markMemo(m, 'd');
  eq(api.cond({ mb: 'rain' }), false, '札を替えても前の札が残る');
  eq(api.cond({ md: 'rain' }), true, '〈疑う〉が立たない');
  api.markMemo(m, 'd');
  eq(api.cond({ md: 'rain' }), false, '同じ札の再押下で保留に戻らない');
  eq(m.mark, null, 'mark が保留に戻らない');
});

test('キーの無いメモには札を付けられない', () => {
  const S = fresh();
  api.applyData({ memo: ['無キー', '本文'] });
  const m = S.memo[S.memo.length - 1];
  api.markMemo(m, 'b');
  eq(m.mark, undefined === m.mark ? m.mark : null, 'キー無しメモに札が付いた');
  eq(Object.keys(S.flags).some(k => k.startsWith('MB_')), false, 'キー無しで MB_ が立った');
});

/* ------------------------------------------------------------
   追補 §6-2 同時着信：取れるのは一本。残りは留守電に落ちる
   ------------------------------------------------------------ */
test('同時着信は3場面あり、取らなかった側は留守電と代償を持つ', () => {
  const multis = [];
  for (const [ch, arr] of Object.entries(SCENARIO))
    arr.forEach(n => { if (n.multi) multis.push([ch, n]); });
  eq(multis.length, 2, '同時着信（両方が鳴る形）の場面数が設計と違う');
  // 第三章は通話中に第二回線が鳴る形なので multi ではなく保留で表現される（追補 §6-3）
  const hold = SCENARIO.ch3.find(n => n.hold === 'HYU');
  const resume = SCENARIO.ch3.find(n => n.resume);
  assert(hold && resume, '第三章の保留（ヒュウ／ムニ）が無い');
  for (const [ch, nd] of multis) {
    assert(nd.sec, `${ch} の同時着信に制限時間が無い`);
    assert(nd.miss, `${ch} の同時着信に取り逃し時の行き先が無い`);
    for (const o of nd.multi) {
      assert(o.label && o.go, `${ch} の回線に label / go が無い`);
      assert(o.vm || o.skip, `${ch} の回線に、取らなかった場合の帰結が無い`);
    }
  }
});

test('同時着信で取らなかった回線は留守電に落ち、保存期限の対象になる', () => {
  const S = fresh();
  const nd = SCENARIO.ch2.find(n => n.multi);
  const dropped = nd.multi[1];                       // レニィ側を取り逃す
  api.applyData({ vm: dropped.vm });
  api.applyPar(dropped.skip);
  eq(S.vm.length, 1, '留守電に落ちていない');
  eq(S.vm[0].k, dropped.vm[2], '留守電にキーが引き継がれていない');
  S.day = 3;
  eq(api.expireVM(), 1, '取り逃した留守電が保存期限の対象になっていない');
});

/* ------------------------------------------------------------
   追補 §6-5 終章は意図的に時間が足りない
   ------------------------------------------------------------ */
test('終章は02:10開始で残110分。準備を全部はこなせない', () => {
  const S = fresh();
  const start = SCENARIO.fin.find(n => n.clock === '02:10');
  assert(start, '終章の開始時刻が 02:10 でない');
  api.applyTime({ day: 13 });
  api.applyTime({ clock: '02:10' });
  eq(api.timeLeft(), 110, '残り時間が110分でない');

  const prep = SCENARIO.fin.find(n => n.ch && n.ch.some(o => o.go === 'prep_neo'));
  const neo = prep.ch.find(o => o.go === 'prep_neo');
  eq(neo.cost, 45, '連携準備の所要時間が45分でない');
  // 3:33 のムニ回線に残る枠は 27分。鍵(18)と声(18)は両立しない
  const mun = SCENARIO.fin.find(n => n.ch && n.ch.some(o => o.go === 'prep_key'));
  const key = mun.ch.find(o => o.go === 'prep_key');
  const voice = mun.ch.find(o => o.go === 'prep_check3');
  eq(key.cost, 18, '鍵の伝達が18分でない');
  eq(voice.cost, 18, '声の伝達が18分でない');
  assert(key.cost + voice.cost > 27, '27分枠に両方が収まってしまう（詰めて二つ、の設計と矛盾）');
});

test('残り時間が足りないと {time:N} の選択肢は押せない', () => {
  const S = fresh();
  api.SET('MUN_TEACH_01');
  const mun = SCENARIO.fin.find(n => n.ch && n.ch.some(o => o.go === 'prep_key'));
  const voice = mun.ch.find(o => o.go === 'prep_check3');
  S.clock = api.SHIFT_END - 18;
  eq(api.cond(voice.req), true, '18分残っているのに押せない');
  S.clock = api.SHIFT_END - 17;
  eq(api.cond(voice.req), false, '17分しか無いのに押せてしまう');
});

test('終章の三回線同時接続は、ネオの留守電を聞いていないと出ない', () => {
  const node = SCENARIO.fin.find(n => n.ch && n.ch.some(o => o.go === 'line_all'));
  const opt = node.ch.find(o => o.go === 'line_all');
  assert(opt.hide, '三回線の選択肢に解放条件が無い');
  fresh();
  eq(api.visibleChoices(node).some(o => o.go === 'line_all'), false, '留守電未再生でも選べてしまう');
  api.SET('VM_neo_three');
  eq(api.visibleChoices(node).some(o => o.go === 'line_all'), true, '留守電を聞いても選べない');
});

/* ------------------------------------------------------------ */
console.log('ミッドナイトライン ― 回帰テスト\n');
for (const [mark, name] of results) {
  (mark === 'ok' ? console.log : console.error)(`  ${mark}  ${name}`);
}
console.log('');
if (failures) { console.error(`失敗 ${failures} 件 / 全 ${results.length} 件`); process.exit(1); }
console.log(`全 ${results.length} 件の回帰テストを通過しました。`);
