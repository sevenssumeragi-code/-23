#!/usr/bin/env node
/* ============================================================
   実ブラウザ通しプレイ検証

   tools/routes.json の各ルートを、game/midnightline.html の画面上で
   実際にボタンをクリックして最後まで進める。
   ヘッドレス検証（check.mjs）が「状態遷移として正しいか」を見るのに対し、
   こちらは「人が普通に操作して本当に遊べるか」を見る。

     node tools/playthrough.mjs            全ルート + セーブ/ロード + 周回
     node tools/playthrough.mjs BAD TRUE   ルートを指定
     node tools/playthrough.mjs --headed   画面を出す

   確認項目:
     - JavaScript 例外が出ないこと
     - 進行が止まらないこと
     - 画面に undefined / NaN が出ないこと
     - 選択肢が押せること
     - 想定どおりのエンディングに到達すること
     - セーブ / ロードで状態が復元されること
     - 「次の周回へ」で周回でき、残るべき情報が残ること

   playwright が無い環境ではスキップして正常終了する。
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
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.log('playwright が見つからないため通しプレイ検証をスキップします。');
  process.exit(0);
}
if (!existsSync(ROUTES)) {
  console.log('tools/routes.json がありません。先に `node tools/check.mjs --record` を実行してください。');
  process.exit(0);
}

const argv    = process.argv.slice(2);
const HEADED  = argv.includes('--headed');
const only    = argv.filter(a => !a.startsWith('--'));
const routes  = JSON.parse(readFileSync(ROUTES, 'utf8'));

let failures = 0;
const ok   = m => console.log('  ok  ' + m);
const fail = m => { failures++; console.error('  NG  ' + m); };

/* ------------------------------------------------------------
   ページ内で動く操作ドライバ。
   実際の DOM 要素を click() して進める。ゲーム側の関数は呼ばない
   （advance / judge などを直接叩くと「操作して遊べるか」の検証にならない）。
   ------------------------------------------------------------ */
async function driveOneLoop(trace) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const q  = s => document.querySelector(s);
  const seen = { choices: 0, skipped: 0, stills: 0, cards: 0, listened: 0 };
  let traceIdx = 0;

  /* 新しい録音が入ったら、資料パネルを開いて 0.5 倍速で聴く。
     裏に入っている声を暴かないと証拠フラグが立たず、灰堂の特定や
     波形照合ができない。熱心なプレイヤーが必ずやる操作なので、
     ヘッドレス検証も「入手したら必ず聴く」前提で手順を記録している。 */
  async function listenToNewRecordings() {
    const recBtn = [...document.querySelectorAll('#nav button')].find(b => b.dataset.p === 'rec');
    if (!recBtn || !recBtn.querySelector('.badge')) return;
    recBtn.click();
    await sleep(40);
    const n = document.querySelectorAll('#pBody [data-md="slow"]').length;
    for (let i = 0; i < n; i++) {
      const btns = document.querySelectorAll('#pBody [data-md="slow"]');
      if (!btns[i]) break;
      btns[i].click();          // playRec(i,'slow') が走り、パネルが再描画される
      seen.listened++;
      await sleep(40);
    }
    q('#pClose').click();
    await sleep(30);
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    // エンディング画面（.endname を持つ .ov）が出たら終了
    const endName = document.querySelector('.ov .endname');
    if (endName) {
      const tag = document.querySelector('.ov .sub');
      return { end: (tag ? tag.textContent : '').replace(/\s*END\s*$/, '').trim(), seen };
    }
    // 章タイトルカードは自動で消えるまで待つ
    if (q('.chapcard')) { seen.cards++; await sleep(300); continue; }
    // 録音が増えていたら聴く（パネルを開くので他の操作より先に済ませる）
    await listenToNewRecordings();
    // スチルはクリックで閉じる
    if (q('#stillview.on')) { seen.stills++; q('#stillview').click(); await sleep(120); continue; }

    // 選択肢
    const btns = [...document.querySelectorAll('#choices .cbtn')];
    if (btns.length) {
      const usable = btns.filter(b => !b.classList.contains('lock'));
      if (!usable.length) {
        // 押せる選択肢が無い＝制限時間切れを待つしかない設計
        await sleep(400);
        continue;
      }
      // 手順は「押せる選択肢が出た回数」と 1:1 で記録されているので、
      // 見つかっても見つからなくても必ず 1 つ消費する（check.mjs と同じ数え方）
      const want = trace[traceIdx++];
      // ボタン文言は「タグ + 本文」なので末尾一致で照合する
      const target = usable.find(b => b.textContent.trim().endsWith(want)) || usable[0];
      seen.choices++;
      target.click();
      await sleep(60);
      continue;
    }

    // 本文送り。1回目のクリックでタイプ表示を飛ばし、2回目で次へ進む
    const wrap = q('#textwrap');
    if (wrap) { seen.skipped++; wrap.click(); await sleep(16); continue; }
    await sleep(50);
  }
  return { end: 'TIMEOUT', seen };
}

/** 画面に undefined / NaN / [object Object] が出ていないか */
function scanForGarbage() {
  const t = document.body.innerText || '';
  const hits = [];
  for (const pat of ['undefined', 'NaN', '[object Object]']) {
    if (t.includes(pat)) hits.push(pat);
  }
  return hits;
}

/* ------------------------------------------------------------ */
async function runRoute(browser, end, route) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);   // 0 にすると要素が押せないとき無言で永久待機する
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(PAGE);
  await page.waitForSelector('#mNew');
  // ヘッドレスでは WebAudio が無駄なので先に切る。ゲーム進行そのものには関与しない
  // （#bSound はタイトルや章カードに覆われるタイミングがあり UI クリックでは掴めない）
  await page.evaluate(() => { AU.on = false; });
  await page.click('#mNew');

  let result = null;
  const notes = [];
  for (let loop = 0; loop < route.loops; loop++) {
    result = await page.evaluate(driveOneLoop, route.runs[loop]);
    if (result.end === 'TIMEOUT') { fail(`${end} 周回${loop + 1} で進行が止まった`); await page.close(); return; }

    const garbage = await page.evaluate(scanForGarbage);
    if (garbage.length) fail(`${end} 周回${loop + 1} の画面に ${garbage.join(' / ')} が表示された`);

    const state = await page.evaluate(() => ({
      loop: S.loop, recs: (G.recs || []).length, memo: S.memo.length,
      endings: (G.endings || []).slice(), saved: !!localStorage.getItem('ml:save')
    }));
    notes.push(`周回${loop + 1}: ${result.end} / 選択${result.seen.choices}回 / 録音${state.recs}件 / メモ${state.memo}件`);

    if (!state.saved) fail(`${end} 周回${loop + 1} 終了時に localStorage へ保存されていない`);

    if (loop < route.loops - 1) {
      // 「次の周回へ」を実際にクリックして周回する
      await page.waitForSelector('#eNext');
      const before = await page.evaluate(() => ({ memo: S.memo.length, recs: (G.recs || []).length }));
      await page.click('#eNext');
      await page.waitForFunction(() => !document.querySelector('.ov') && typeof S !== 'undefined' && S.chapter === 'pro');
      const after = await page.evaluate(() => ({
        loop: S.loop, memo: S.memo.length, recs: (G.recs || []).length,
        trust: S.chars.LEN.trust, flags: Object.keys(S.flags).length
      }));
      // 引き継ぐべきもの / リセットすべきもの
      if (after.loop !== loop + 2) fail(`${end} 周回カウントが ${after.loop}（期待 ${loop + 2}）`);
      if (after.memo < before.memo) fail(`${end} 相談メモが周回に引き継がれていない`);
      if (after.recs < before.recs) fail(`${end} 録音の暴露状態が周回に引き継がれていない`);
      if (after.trust !== 20) fail(`${end} 信頼度がリセットされていない（LEN=${after.trust}）`);
    }
  }

  const got = result.end;
  if (got !== end) fail(`${end} を狙ったが ${got} に到達した`);
  else if (errs.length) fail(`${end} 到達したが JS 例外あり: ${errs[0]}`);
  else ok(`${end.padEnd(6)} 到達　${notes.join(' / ')}`);
  if (errs.length) errs.slice(0, 3).forEach(e => console.error('      ' + e));
  await page.close();
}

/** セーブ → リロード → 「続きから」で状態が戻るか */
async function runSaveLoad(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(PAGE);
  await page.waitForSelector('#mNew');
  await page.evaluate(() => { AU.on = false; });
  await page.click('#mNew');

  // しばらく普通に進める（選択肢は先頭を押す）
  await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 400; i++) {
      if (document.querySelector('.chapcard')) { await sleep(300); continue; }
      if (document.querySelector('#stillview.on')) { document.querySelector('#stillview').click(); await sleep(100); continue; }
      const b = [...document.querySelectorAll('#choices .cbtn')].filter(x => !x.classList.contains('lock'));
      if (b.length) { b[0].click(); await sleep(60); continue; }
      document.querySelector('#textwrap').click();
      await sleep(16);
    }
  });

  const before = await page.evaluate(() => ({
    day: S.day, chapter: S.chapter, clock: S.clock,
    flags: Object.keys(S.flags).length, memo: S.memo.length, trust: S.chars.LEN.trust
  }));
  // MENU からの手動保存も実際に押す
  await page.click('#bMenu');
  await page.click('[data-sys="save"]');
  await page.click('#pClose');

  await page.reload();
  await page.waitForSelector('#mCont');
  await page.click('#mCont');
  await page.waitForFunction(() => typeof S !== 'undefined' && S.day != null && !document.querySelector('#title'));

  const after = await page.evaluate(() => ({
    day: S.day, chapter: S.chapter, clock: S.clock,
    flags: Object.keys(S.flags).length, memo: S.memo.length, trust: S.chars.LEN.trust,
    titleGone: !document.querySelector('#title'),
    navRendered: document.querySelectorAll('#nav button').length > 0
  }));

  const same = ['day', 'chapter', 'clock', 'flags', 'memo', 'trust'].filter(k => before[k] !== after[k]);
  if (same.length) fail(`セーブ/ロードで ${same.join(',')} が復元されない（前 ${JSON.stringify(before)} / 後 ${JSON.stringify(after)}）`);
  else if (!after.titleGone) fail('「続きから」でタイトル画面が消えていない');
  else if (!after.navRendered) fail('「続きから」で資料パネルが再構築されていない');
  else if (errs.length) fail('セーブ/ロードで JS 例外: ' + errs[0]);
  else ok(`セーブ/ロード　DAY${after.day} ${after.chapter} フラグ${after.flags}件 メモ${after.memo}件 を復元`);
  await page.close();
}

/* ------------------------------------------------------------ */
console.log('ミッドナイトライン ― 実ブラウザ通しプレイ\n');
const browser = await chromium.launch({ headless: !HEADED });
const targets = Object.entries(routes).filter(([e]) => !only.length || only.includes(e));
for (const [end, route] of targets) await runRoute(browser, end, route);
if (!only.length) await runSaveLoad(browser);
await browser.close();

console.log('');
if (failures) { console.error(`失敗 ${failures} 件`); process.exit(1); }
console.log('実ブラウザでの通しプレイがすべて成功しました。');
