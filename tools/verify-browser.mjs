#!/usr/bin/env node
/* ============================================================
   検証（実ブラウザ）: tools/routes.json の各ルートを
   game/midnightline.html の実装そのもので再生し、
   ヘッドレス検証（tools/check.mjs）と同じENDに着くか確かめる。

   check.mjs は core.js を共有しているので状態遷移は同一のはずだが、
   engine.js 側にしか無い処理（playRec による録音フラグの再設定など）は
   ここでしか検証できない。実際、この照合で 2 件のバグが見つかっている。

     node tools/verify-browser.mjs

   playwright が無い環境では何もせず正常終了する（任意の追加検証）。
   ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = join(ROOT, 'tools', 'routes.json');
const PAGE   = 'file://' + join(ROOT, 'game', 'midnightline.html');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright'));
} catch {
  console.log('playwright が見つからないためブラウザ検証をスキップします。');
  console.log('  npm i -D playwright  で有効になります。');
  process.exit(0);
}
if (!existsSync(ROUTES)) {
  console.log('tools/routes.json がありません。先に `node tools/check.mjs --record` を実行してください。');
  process.exit(0);
}

/* ブラウザ内で 1 キャンペーン（複数周回）を再生して END を返す。
   表示と演出だけを飛ばし、状態遷移はページ上の実関数に任せる。 */
function replayInPage({ runs }) {
  AU.on = false;
  setGlobal({ loops: 0, endings: [], recs: [], stills: [] });
  let ending = null;

  for (let loop = 0; loop < runs.length; loop++) {
    const trace = runs[loop];
    let k = 0;
    // startGame(carry) と同じ手順で周回コンテキストを作る
    setState(newState(G.loops ? G : null));
    if (G.loops) {
      S.loop = (G.loops || 0) + 1;
      (G.memo || []).forEach(m => S.memo.push(m));
      (G.evd  || []).forEach(e => S.evd.push(e));
      (G.rel  || []).forEach(x => S.rel.push(x));
      if (G.tl && G.tl.length > S.tl.length) S.tl = G.tl.slice();
      SET('LOOP_02', S.loop);
    }
    loadChapter('pro');

    let guard = 0;
    ending = null;
    while (guard++ < 200000) {
      if (pc >= script.length) return 'FELL_OFF_END:' + S.chapter;
      const nd = script[pc++];
      // 表示系（本来はここでユーザー入力を待つ）
      if (nd.say != null || nd.me != null) { S.clock += 1; continue; }
      if (nd.nar != null || nd.sys != null) continue;
      // 演出系
      if (nd.call) { S.cur = nd.call; S.callStart = S.clock; }
      if (nd.hang != null) { if (S.cur) S.hist.push({ d: S.day, w: S.cur.who, r: nd.hang }); S.cur = null; }
      if (nd.noise != null) S.noise = nd.noise;
      if (nd.clock || nd.day) applyTime(nd);
      // データ系
      applyData(nd);
      // 録音は入手直後に 0.5 倍速で聴く（engine.js の playRec をそのまま呼ぶ）
      if (nd.rec) { const i = S.recs.length - 1; if (S.recs[i] && S.recs[i].hid) playRec(i, 'slow'); }
      if (nd.still) {
        if (!S.stills.includes(nd.still)) S.stills.push(nd.still);
        G.stills = G.stills || [];
        if (!G.stills.includes(nd.still)) G.stills.push(nd.still);
        continue;
      }
      if (nd.chapTitle) S.chapTitle = nd.chapTitle;
      if (nd.card || nd.wait) continue;
      // 制御系
      if (nd.ch) {
        const sel = selectableChoices(nd);
        let o;
        if (!sel.length) o = timeoutChoice(nd);
        else { const want = trace[k++]; o = sel.find(x => x.t === want) || sel[0]; }
        applyChoice(o);
        if (o.go) jump(o.go);
        continue;
      }
      const t = resolveJump(nd);
      if (t) jump(t);
      if (nd.chap) { loadChapter(nd.chap); continue; }
      if (nd.end) { ending = nd.end === 'check' ? judge() : nd.end; break; }
    }
    // endGame の引き継ぎ処理
    G.endings = G.endings || [];
    if (!G.endings.includes(ending)) G.endings.push(ending);
    G.memo = S.memo.slice(); G.evd = S.evd.slice();
    G.rel  = S.rel.slice();  G.tl  = S.tl.slice();
    G.loops = (G.loops || 0) + 1;
    G.recs = G.recs || []; G.stills = G.stills || [];
  }
  return ending;
}

const routes = JSON.parse(readFileSync(ROUTES, 'utf8'));
const browser = await chromium.launch();
let failures = 0;

console.log('ミッドナイトライン ― 実ブラウザ照合\n');
for (const [end, route] of Object.entries(routes)) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE);
  await page.waitForTimeout(200);

  let got;
  try {
    got = await page.evaluate(replayInPage, route);
  } catch (e) {
    got = 'EVAL_ERROR: ' + e.message;
  }
  const pass = got === end && !errs.length;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok' : 'NG'}  ${end.padEnd(6)} → ${got}` + (errs.length ? `  [JSエラー: ${errs[0]}]` : ''));
  await page.close();
}
await browser.close();

console.log('');
if (failures) { console.error(`失敗 ${failures} 件 — ヘッドレス検証とブラウザ実装が食い違っています。`); process.exit(1); }
console.log('ヘッドレス検証とブラウザ実装の結果が一致しました。');
