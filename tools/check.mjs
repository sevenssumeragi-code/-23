#!/usr/bin/env node
/* ============================================================
   検証: シナリオの静的検査 + 全ルート自動プレイ

   静的検査の内訳:
     ラベル参照 / 章参照 / END参照 / キャラ参照 / スチル参照 / フラグ参照
     ノードキー / 選択肢キー / 条件キー / パラメータ名 / 生死の値 / noise の範囲
     ラベル重複 / 到達不能ラベル / 到達不能ノード
     表示系ノードへの無視されるキーの同居 / go と if の同居
     {sec:n} の配置 / 制限時間つき選択肢の timeout / 進行不能な選択肢

     node tools/check.mjs              静的検査 + ルート探索 + 固定ルート再生
     node tools/check.mjs --record     到達したルートを tools/routes.json に保存
     node tools/check.mjs --rollouts N 乱択ロールアウト回数（既定 20000）
     node tools/check.mjs --seed N     乱数シード（既定 20260813）
     node tools/check.mjs --quiet      要約だけ出す

   ロジックは src/core.js をそのまま読み込んで使う。
   検証スクリプト側でノードの意味論を再実装しないための構成。
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApi, freshG } from './load-core.mjs';

const ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = join(ROOT, 'tools', 'routes.json');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const RECORD   = argv.includes('--record');
const QUIET    = argv.includes('--quiet');
const ROLLOUTS = Number(opt('--rollouts', 20000));
const SEED     = Number(opt('--seed', 20260813));

const ENDS = ['BAD', 'NORMAL', 'GOOD', 'TRUE', 'SECRET'];
let failures = 0;
const fail = m => { failures++; console.error('  NG  ' + m); };
const ok   = m => { if (!QUIET) console.log('  ok  ' + m); };
const head = m => { if (!QUIET) console.log('\n' + m); };

const api = loadApi();
const { SCENARIO, STILLS } = api;

/* ============================================================
   2. 静的検査
   ============================================================ */
const NODE_KEYS = new Set([
  'n', 'say', 'c', 'nm', 'slow', 'w', 'se', 'me', 'nar', 'sys',
  'call', 'hang', 'hangKind', 'ring', 'noise', 'fx', 'amb', 'clock', 'day',
  'still', 'card', 'chapTitle', 'wait',
  'set', 'inc', 'par', 'meet', 'known', 'know', 'life', 'memo', 'evd',
  'tl', 'tlfix', 'rel', 'vm', 'rec', 'toastx',
  'ch', 'sec', 'go', 'if', 'then', 'go2', 'els', 'chap', 'end', 'clear'
]);
const CHOICE_KEYS = new Set([
  't', 'tag', 'line', 'say', 'silent', 'req', 'hide', 'eff', 'set', 'inc',
  'memo', 'cost', 'timeout', 'go'
]);
const COND_KEYS = new Set(['and', 'or', 'f', 'nf', 'cnt', 'tr', 'dbt', 'alive', 'loop', 'recs', 'cleared']);
const LIFE_VALUES = new Set(['生存', '危篤', '死亡', '消失']);

function staticChecks() {
  head('■ 静的検査');
  const chapters = Object.keys(SCENARIO);
  const stillIds = new Set(STILLS.map(s => s.id));
  const charIds  = new Set(Object.keys(api.CHARS));
  const tracked  = new Set(api.TRACKED);

  // --- 全フラグの set / 参照を集計 ---
  const setFlags = new Set(), readFlags = new Map();
  const noteRead = (f, where) => { if (!readFlags.has(f)) readFlags.set(f, []); readFlags.get(f).push(where); };
  const walkCond = (c, where) => {
    if (!c || typeof c !== 'object') return;
    for (const k of Object.keys(c)) {
      if (!COND_KEYS.has(k)) fail(`未知の条件キー "${k}" (${where})`);
    }
    if (c.and) c.and.forEach(x => walkCond(x, where));
    if (c.or)  c.or.forEach(x => walkCond(x, where));
    if (c.f)  noteRead(c.f, where);
    if (c.nf) noteRead(c.nf, where);
    if (c.cnt) noteRead(c.cnt[0], where);
    if (c.tr && !tracked.has(c.tr[0]))   fail(`tr の対象が追跡外のキャラ "${c.tr[0]}" (${where})`);
    if (c.dbt && !tracked.has(c.dbt[0])) fail(`dbt の対象が追跡外のキャラ "${c.dbt[0]}" (${where})`);
    if (c.alive && !tracked.has(c.alive)) fail(`alive の対象が追跡外のキャラ "${c.alive}" (${where})`);
  };

  let totalNodes = 0, totalLabels = 0, totalChoices = 0;

  for (const ch of chapters) {
    const arr = SCENARIO[ch];
    const idx = {};
    arr.forEach((n, i) => {
      if (!n.n) return;
      if (idx[n.n] != null) fail(`ラベル重複 ${ch}:${n.n}`);
      idx[n.n] = i;
    });
    totalNodes += arr.length;
    totalLabels += Object.keys(idx).length;

    arr.forEach((nd, i) => {
      const where = `${ch}[${i}]`;
      for (const k of Object.keys(nd)) {
        if (!NODE_KEYS.has(k)) fail(`未知のノードキー "${k}" (${where})`);
      }
      // ジャンプ先
      const jumps = [nd.go, nd.then, nd.go2, nd.els].filter(Boolean);
      for (const j of jumps) if (idx[j] == null) fail(`未定義ラベルへのジャンプ "${j}" (${where})`);
      // 章移動
      if (nd.chap && !SCENARIO[nd.chap]) fail(`未定義の章へ chap:"${nd.chap}" (${where})`);
      // エンディング
      if (nd.end && nd.end !== 'check' && !ENDS.includes(nd.end)) fail(`未知の end:"${nd.end}" (${where})`);
      if (nd.end && nd.end !== 'check' && !api.ENDINGS[nd.end]) fail(`ENDINGS に文面が無い end:"${nd.end}" (${where})`);
      // 話者
      if (nd.say != null && nd.c && !charIds.has(nd.c)) fail(`未知のキャラID c:"${nd.c}" (${where})`);
      if (nd.call && nd.call.c && !charIds.has(nd.call.c)) fail(`未知のキャラID call.c:"${nd.call.c}" (${where})`);
      // スチル
      if (nd.still && !stillIds.has(nd.still)) fail(`未定義のスチルID "${nd.still}" (${where})`);
      // 生死
      if (nd.life) {
        if (!tracked.has(nd.life[0])) fail(`life の対象が追跡外のキャラ "${nd.life[0]}" (${where})`);
        if (!LIFE_VALUES.has(nd.life[1])) fail(`未知の生死状態 "${nd.life[1]}" (${where})`);
      }
      // meet / know は TRACKED 外のキャラにも使える（フラグだけ立つ）。
      // ただし CHARS に存在しないIDは表示できないので誤りとみなす。
      if (nd.meet && !charIds.has(nd.meet)) fail(`未知のキャラID meet:"${nd.meet}" (${where})`);
      if (nd.know && !charIds.has(nd.know[0])) fail(`未知のキャラID know:"${nd.know[0]}" (${where})`);
      if (nd.know && !tracked.has(nd.know[0])) fail(`know は追跡対象のキャラにしか効かない "${nd.know[0]}" (${where})`);
      // ノイズ
      if (nd.noise != null && !(nd.noise >= 0 && nd.noise <= 3)) fail(`noise が範囲外 ${nd.noise} (${where})`);
      // 独立した {sec:n} ノードは直後の選択肢ノードに適用される。
      // 直後が選択肢でないと値が宙に浮き、後続の無関係な選択肢に漏れる。
      if (nd.sec != null && !nd.ch) {
        const next = arr[i + 1];
        if (!next || !next.ch) fail(`{sec:${nd.sec}} の直後が選択肢ノードではない (${where})`);
      }
      // 表示系ノードに状態変更が同居していないか（exec が即 return するため無視される）
      const isDisplay = nd.say != null || nd.me != null || nd.nar != null || nd.sys != null;
      if (isDisplay) {
        const ignored = ['set', 'inc', 'par', 'go', 'if', 'ch', 'end', 'memo', 'evd', 'life', 'still', 'chap']
          .filter(k => nd[k] != null);
        if (ignored.length) fail(`表示系ノードに無視されるキー ${ignored.join(',')} が同居 (${where})`);
      }
      // go と if の同居（go が先に評価されるため意図しない挙動になる）
      if (nd.go && nd.if) fail(`go と if が同居している (${where})`);
      // フラグ
      if (nd.set) Object.keys(nd.set).forEach(f => setFlags.add(f));
      if (nd.inc) Object.keys(nd.inc).forEach(f => setFlags.add(f));
      if (nd.rec && nd.rec.flag) setFlags.add(nd.rec.flag);
      if (nd.meet) setFlags.add('MET_' + nd.meet);
      walkCond(nd.if, where);
      // 選択肢
      if (nd.ch) {
        totalChoices++;
        if (!nd.ch.length) fail(`空の選択肢ノード (${where})`);
        nd.ch.forEach((o, j) => {
          const w2 = `${where}.ch[${j}]`;
          for (const k of Object.keys(o)) if (!CHOICE_KEYS.has(k)) fail(`未知の選択肢キー "${k}" (${w2})`);
          if (o.go && idx[o.go] == null) fail(`未定義ラベルへのジャンプ "${o.go}" (${w2})`);
          if (o.t == null) fail(`選択肢に t がない (${w2})`);
          if (o.set) Object.keys(o.set).forEach(f => setFlags.add(f));
          if (o.inc) Object.keys(o.inc).forEach(f => setFlags.add(f));
          if (o.eff) Object.keys(o.eff).forEach(k => {
            const [c, p] = k.split('.');
            if (!tracked.has(c)) fail(`eff の対象が追跡外のキャラ "${c}" (${w2})`);
            if (!['trust', 'doubt', 'fear', 'stress'].includes(p)) fail(`未知のパラメータ "${p}" (${w2})`);
          });
          walkCond(o.req, w2);
          walkCond(o.hide, w2);
        });
        // 制限時間は直前の独立ノード {sec:n} で与えられることがある
        const effSec = nd.sec != null ? nd.sec : (arr[i - 1] && arr[i - 1].sec);
        // 制限時間つきなのに timeout 指定が無い場合、表示末尾が選ばれる（事故のもと）
        if (effSec && !nd.ch.some(o => o.timeout)) {
          fail(`sec:${effSec} があるのに timeout:1 の選択肢が無い (${where})`);
        }
        // 制限時間が無いのに全選択肢が条件つきだと、条件を満たさないプレイヤーは
        // 何も押せず進行不能になる。無条件の逃げ道が最低1つ要る。
        if (!effSec && !nd.ch.some(o => !o.req && !o.hide)) {
          fail(`sec が無く、全選択肢が req / hide つき。条件を満たさないと進行不能 (${where})`);
        }
      }
    });

    // --- 到達性（ラベル単位） ---
    const seen = new Set(), stack = [0];
    while (stack.length) {
      let i = stack.pop();
      while (i < arr.length && !seen.has(i)) {
        seen.add(i);
        const nd = arr[i];
        if (nd.ch) {
          nd.ch.forEach(o => { if (o.go && idx[o.go] != null) stack.push(idx[o.go]); });
          if (nd.ch.every(o => o.go)) break;   // 全選択肢が go を持つなら素通しは起きない
          i++; continue;
        }
        if (nd.end || nd.chap) break;
        if (nd.if) {
          const t = nd.go2 || nd.then;
          if (idx[t] != null) stack.push(idx[t]);
          if (nd.els && idx[nd.els] != null) stack.push(idx[nd.els]);
          if (nd.go && idx[nd.go] != null) { i = idx[nd.go]; continue; }
          i++; continue;
        }
        if (nd.go) { if (idx[nd.go] != null) { i = idx[nd.go]; continue; } break; }
        i++;
      }
    }
    arr.forEach((nd, i) => { if (nd.n && !seen.has(i)) fail(`到達不能なラベル ${ch}:${nd.n}`); });
    // ラベルの付いていないノードも含めて、章の先頭からどれも到達できること
    const deadNodes = arr.map((_, i) => i).filter(i => !seen.has(i));
    if (deadNodes.length) {
      fail(`到達不能なノード ${deadNodes.length} 件 (${ch}: index ${deadNodes.slice(0, 10).join(',')}${deadNodes.length > 10 ? ' …' : ''})`);
    }
  }

  // --- 参照だけされて一度も立たないフラグ ---
  for (const [f, wheres] of readFlags) {
    if (!setFlags.has(f)) fail(`どこでも set されないフラグを参照 "${f}" (${wheres[0]} 他 ${wheres.length}箇所)`);
  }

  ok(`章 ${chapters.length} / ノード ${totalNodes} / ラベル ${totalLabels} / 選択肢ノード ${totalChoices}`);
  ok(`フラグ 定義 ${setFlags.size} 種 / 参照 ${readFlags.size} 種`);
  return { setFlags, readFlags };
}

/* ============================================================
   3. ヘッドレス実行エンジン
   engine.js の exec() から DOM 依存を除いたもの。
   状態変更はすべて core.js の applyData / applyChoice / resolveJump に委譲する。
   ============================================================ */
const MAX_STEPS = 200000;

class Play {
  constructor(rng, policy) {
    this.rng = rng;
    this.policy = policy;
    this.trace = [];          // 選んだ手の記録
    this.steps = 0;
    this.ended = null;
  }
  loadChapter(id, ) {
    this.script = SCENARIO[id];
    this.labels = {};
    this.script.forEach((n, i) => { if (n.n) this.labels[n.n] = i; });
    api.getS().chapter = id;
    this.pc = 0;
  }
  jump(l) {
    if (this.labels[l] == null) throw new Error('no label ' + l);
    this.pc = this.labels[l];
  }
  /** 1周分を最後まで走らせて END 名を返す */
  run() {
    this.loadChapter('pro');
    while (this.ended == null) {
      if (++this.steps > MAX_STEPS) throw new Error('ステップ上限に達した（無限ループの疑い）');
      if (this.pc >= this.script.length) throw new Error(`章 ${api.getS().chapter} の末尾に落ちた（end も chap も無い）`);
      this.exec(this.script[this.pc++]);
    }
    return this.ended;
  }
  exec(nd) {
    const S = api.getS();
    // 表示系（exec はここで return する）
    if (nd.say != null) { S.clock += 1; return; }
    if (nd.me != null)  { S.clock += 1; return; }
    if (nd.nar != null) return;
    if (nd.sys != null) return;
    // 演出系
    if (nd.call) { S.cur = nd.call; S.callStart = S.clock; }
    if (nd.hang != null) {
      if (S.cur) S.hist.push({ d: S.day, w: S.cur.who, r: nd.hang });
      S.cur = null;
    }
    if (nd.noise != null) S.noise = nd.noise;
    if (nd.clock || nd.day) api.applyTime(nd);
    // データ系（core と共通）
    api.applyData(nd);
    if (nd.rec) this.onRecording();
    if (nd.still) {
      if (!S.stills.includes(nd.still)) S.stills.push(nd.still);
      const G = api.getG();
      G.stills = G.stills || [];
      if (!G.stills.includes(nd.still)) G.stills.push(nd.still);
      return;
    }
    if (nd.chapTitle) S.chapTitle = nd.chapTitle;
    if (nd.card) return;
    if (nd.wait) return;
    // 制御系
    if (nd.ch) return this.choose(nd);
    const target = api.resolveJump(nd);
    if (target) this.jump(target);
    if (nd.chap) { this.loadChapter(nd.chap); return; }
    if (nd.end) { this.ended = nd.end === 'check' ? api.judge() : nd.end; return; }
  }
  /** 録音を入手した直後。0.5倍速で聴くかどうかは方針しだい */
  onRecording() {
    const S = api.getS(), G = api.getG();
    const r = S.recs[S.recs.length - 1];
    if (!r || !r.hid) return;
    if (!this.policy.listen(this.rng)) return;
    r.opened = 1;
    if (r.flag) api.SET(r.flag);
    G.recs = G.recs || [];
    if (!G.recs.includes(r.id)) G.recs.push(r.id);
  }
  choose(nd) {
    const S = api.getS();
    const selectable = api.selectableChoices(nd);
    // 押せる選択肢が無いノードは、制限時間切れ相当（＝沈黙）でしか抜けられない
    let o;
    if (!selectable.length) {
      o = api.timeoutChoice(nd);
      if (!o) throw new Error('選択肢が一つも選べない（章 ' + S.chapter + '）');
    } else {
      o = this.policy.pick(selectable, nd, this.rng);
    }
    this.trace.push(o.t);
    api.applyChoice(o);
    if (o.go) this.jump(o.go);
  }
}

/* ============================================================
   4. 方針（policy）
   ============================================================ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 完全乱択 */
const randomPolicy = (listenRate = 0.5) => ({
  listen: rng => rng() < listenRate,
  pick: (list, nd, rng) => list[Math.floor(rng() * list.length)]
});

/**
 * 目標指向。欲しいフラグを立てる手を優先し、避けたいフラグを立てる手を嫌う。
 * ε の確率でランダムに逸れて、局所解から抜ける。
 */
const goalPolicy = (want, avoid, trustSign = 1, eps = 0.15, listenRate = 1) => ({
  listen: rng => rng() < listenRate,
  pick(list, nd, rng) {
    if (rng() < eps) return list[Math.floor(rng() * list.length)];
    let best = null, bestScore = -Infinity;
    for (const o of list) {
      let s = 0;
      const sets = Object.keys(o.set || {});
      const incs = Object.keys(o.inc || {});
      for (const f of sets) {
        if (want.includes(f) && !api.F(f)) s += 1000;
        if (avoid.includes(f)) s -= 1000;
      }
      for (const f of incs) {
        if (avoid.includes(f)) s -= 1000;
        if (want.includes(f)) s += 200;
      }
      // 信頼度は多くの救済ルートの前提条件（tr:[...] の req）なので効かせる
      for (const [k, v] of Object.entries(o.eff || {})) {
        const [, p] = k.split('.');
        if (p === 'trust')  s += trustSign * v * 3;
        if (p === 'fear')   s -= trustSign * v;
        if (p === 'stress') s -= trustSign * v;
      }
      // 「切電」「見送り」は基本的に損（BAD 狙いのときだけ得）
      if (o.tag === '切電' || o.tag === '見送り') s -= trustSign * 300;
      s += rng();  // 同点はランダムに割る
      if (s > bestScore) { bestScore = s; best = o; }
    }
    return best;
  }
});

/* ============================================================
   5. ルート探索
   ============================================================ */
const TRUE_FLAGS = [
  'KAI_EXPOSE_01', 'GER_KNIFE_01', 'JIN_RUSH_01', 'NEO_HYU_01',
  'MUN_TEACH_01', 'MUN_TEACH_02', 'MUN_TEACH_03',
  'EVD_TAPE_01', 'EVD_WAVE_01', 'STORY_TRUE_KEY',
  'HYU_EYE_01', 'HYU_STAY_01', 'NEO_ALLY_01', 'GER_ID_01', 'JIN_LIE_01',
  'LEN_REMEMBER', 'MUN_SAVED', 'RIFT_CLOSED', 'SEC_CALL_01'
];

/** 1周を走らせる。G は呼び出し側が用意する（周回引き継ぎの再現） */
function playOnce(policy, seed, G) {
  api.setGlobal(G);
  const S = api.newState(G.loops ? G : null);
  api.setState(S);
  if (G.loops) {
    S.loop = (G.loops || 0) + 1;
    (G.memo || []).forEach(m => S.memo.push(m));
    (G.evd  || []).forEach(e => S.evd.push(e));
    (G.rel  || []).forEach(r => S.rel.push(r));
    if (G.tl && G.tl.length > S.tl.length) S.tl = G.tl.slice();
    api.SET('LOOP_02', S.loop);
  }
  const p = new Play(mulberry32(seed), policy);
  const end = p.run();
  // endGame 相当の引き継ぎ処理
  G.endings = G.endings || [];
  if (!G.endings.includes(end)) G.endings.push(end);
  G.memo = S.memo.slice(); G.evd = S.evd.slice();
  G.rel  = S.rel.slice();  G.tl  = S.tl.slice();
  G.loops = (G.loops || 0) + 1;
  G.recs = G.recs || []; G.stills = G.stills || [];
  return { end, trace: p.trace, flags: { ...S.flags }, chars: S.chars, loop: S.loop };
}

/** ランダム多数試行で到達するENDを集計 */
function rollouts(n, seed) {
  head(`■ 乱択ロールアウト（${n} 回 / seed ${seed}）`);
  const tally = {};
  const err = new Map();
  for (let i = 0; i < n; i++) {
    try {
      // 半分は1周目、半分は2周目コンテキスト（隠し選択肢を通すため）
      const G = freshG();
      const listen = (i % 3 === 0) ? 1 : 0.4;
      if (i % 2 === 1) { playOnce(randomPolicy(listen), seed + i * 7919, G); }
      const r = playOnce(randomPolicy(listen), seed + i, G);
      tally[r.end] = (tally[r.end] || 0) + 1;
    } catch (e) {
      err.set(e.message, (err.get(e.message) || 0) + 1);
    }
  }
  for (const e of ENDS) ok(`${e.padEnd(6)} ${String(tally[e] || 0).padStart(6)} 回`);
  if (err.size) { for (const [m, c] of err) fail(`実行時エラー ${c} 回: ${m}`); }
  return tally;
}

/** 各ENDを狙い撃ちして到達手順を求める */
function seekRoutes(seed) {
  head('■ ルート到達性（目標指向探索）');
  const plans = {
    // 誰も救わない。切電・見送りを積極的に選ぶ
    BAD: {
      loops: 1,
      policy: () => goalPolicy([], TRUE_FLAGS, -1, 0.2, 1)
    },
    // 現在の事件は収まるが真相は闇の中。灰堂特定はしない
    NORMAL: {
      loops: 1,
      policy: () => goalPolicy(['JIN_RUSH_01', 'GER_KNIFE_01'], ['KAI_EXPOSE_01'], 1, 0.15, 1)
    },
    // 1周目では MUN_TEACH_02 が hide で出ないので、うまくいけば GOOD 止まり
    GOOD: {
      loops: 1,
      policy: () => goalPolicy(TRUE_FLAGS.filter(f => f !== 'SEC_CALL_01'), [], 1, 0.12, 1)
    },
    // 2周目。SEC_CALL_01 は踏まない
    TRUE: {
      loops: 2,
      policy: () => goalPolicy(TRUE_FLAGS.filter(f => f !== 'SEC_CALL_01'), ['SEC_CALL_01'], 1, 0.12, 1)
    },
    // TRUE クリア後の周回で隠し発信 + 隠し録音を全回収。最短で3周
    SECRET: {
      loops: 3,
      policy: () => goalPolicy(TRUE_FLAGS, [], 1, 0.12, 1)
    }
  };

  const found = {};
  const ATTEMPTS = 4000;
  for (const end of ENDS) {
    const plan = plans[end];
    let hit = null, attempts = 0;
    for (let i = 0; i < ATTEMPTS && !hit; i++) {
      attempts++;
      const s = seed + i * 104729;
      try {
        const G = freshG();
        const runs = [];
        for (let l = 0; l < plan.loops; l++) runs.push(playOnce(plan.policy(), s + l * 31, G));
        const last = runs[runs.length - 1];
        if (last.end === end) hit = { seed: s, loops: plan.loops, runs: runs.map(r => r.trace), end: last.end };
      } catch (e) { /* この試行は捨てる */ }
    }
    if (hit) {
      found[end] = hit;
      ok(`${end.padEnd(6)} 到達 (試行 ${attempts} 回 / seed ${hit.seed} / ${hit.loops}周目 / 選択 ${hit.runs[hit.runs.length - 1].length} 手)`);
    } else {
      fail(`${end} に到達できなかった（${ATTEMPTS} 試行）`);
    }
  }
  return found;
}

/** 記録済みルートを決定論的に再生して、同じENDに着くか検査 */
function replayRoutes() {
  if (!existsSync(ROUTES)) {
    head('■ 固定ルート再生');
    ok('tools/routes.json が無いためスキップ（--record で作成）');
    return;
  }
  head('■ 固定ルート再生（回帰テスト）');
  const routes = JSON.parse(readFileSync(ROUTES, 'utf8'));
  for (const [end, r] of Object.entries(routes)) {
    try {
      const G = freshG();
      let last;
      for (let l = 0; l < r.loops; l++) {
        const traceForLoop = r.runs[l];
        let k = 0;
        const policy = {
          listen: () => true,
          pick: (list, nd) => {
            const want = traceForLoop[k++];
            const m = want != null && list.find(o => o.t === want);
            return m || list[0];
          }
        };
        last = playOnce(policy, r.seed + l * 31, G);
      }
      if (last.end === end) ok(`${end.padEnd(6)} 再生 OK`);
      else fail(`${end} を再生したが ${last.end} に着いた`);
    } catch (e) {
      fail(`${end} の再生に失敗: ${e.message}`);
    }
  }
}

/* ============================================================
   6. 実行
   ============================================================ */
console.log('ミッドナイトライン ― シナリオ検証');
staticChecks();
rollouts(ROLLOUTS, SEED);
const found = seekRoutes(SEED);

if (RECORD) {
  const out = {};
  for (const [end, r] of Object.entries(found)) out[end] = { seed: r.seed, loops: r.loops, runs: r.runs };
  writeFileSync(ROUTES, JSON.stringify(out, null, 1) + '\n');
  console.log(`\n  ok  tools/routes.json に ${Object.keys(out).length} ルートを記録しました`);
} else {
  replayRoutes();
}

console.log('');
if (failures) { console.error(`失敗 ${failures} 件`); process.exit(1); }
console.log('すべての検査を通過しました。');
