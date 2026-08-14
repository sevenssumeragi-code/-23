/* ============================================================
   src/core.js とシナリオデータを Node 上へ読み込む共通ローダ。

   ブラウザでの読み込み方（同一スコープに連結された複数スクリプト）を
   vm コンテキストで再現する。検証スクリプトがノードの意味論を
   再実装しないよう、cond / applyData / judge などは常にここ経由で
   本番の実装を使う。
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src');

/** src/index.html の読み込み順と一致させること */
export const CORE_FILES = [
  'data/stills.js', 'data/endings.js', 'data/dials.js', 'scenario/_init.js',
  'scenario/pro.js', 'scenario/ch1.js', 'scenario/ch2.js', 'scenario/ch3.js',
  'scenario/ch4.js', 'scenario/ch5.js', 'scenario/fin.js',
  'core.js'
];

export function loadApi() {
  const ctx = vm.createContext({ console, JSON, Math, Object, Array, String, Number });
  for (const f of CORE_FILES) {
    vm.runInContext(readFileSync(join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext(`globalThis.__api = {
    STILLS, ENDINGS, SCENARIO, CHARS, TRACKED, Hooks,
    newState, setState, setGlobal, cond, applyPar, applyData, applyTime,
    applyChoice, visibleChoices, selectableChoices, timeoutChoice, resolveJump, judge,
    timeLeft, fatigue, realSec, checkShift, callPressure, holdLine, resumeLine, expireVM, markMemo,
    clockStr, SHIFT_END, DIALS,
    F, SET, CNT, getS: () => S, getG: () => G
  };`, ctx);
  return ctx.__api;
}

/** 空の周回跨ぎ状態 */
export function freshG() { return { loops: 0, endings: [], recs: [], stills: [] }; }
