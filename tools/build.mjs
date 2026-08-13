#!/usr/bin/env node
/* ============================================================
   ビルド: src/ → game/midnightline.html（単一ファイル）

   やることは src/index.html の `<!-- @include path -->` を
   ファイル内容に置き換えるだけ。トランスパイルもバンドラも使わない。
   出力は依存ゼロの単一HTMLで、file:// で直接開いて動く。

   使い方:
     node tools/build.mjs           ビルドして書き出す
     node tools/build.mjs --check   書き出さず、既存の出力と一致するか検査
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = join(ROOT, 'src');
const OUT  = join(ROOT, 'game', 'midnightline.html');

const INCLUDE = /^([ \t]*)<!--[ \t]*@include[ \t]+([^\s>]+)[ \t]*-->[ \t]*$/;

/** src/index.html を読み、@include を再帰的に展開する */
export function build() {
  const entry = join(SRC, 'index.html');
  if (!existsSync(entry)) throw new Error(`エントリが見つかりません: ${entry}`);
  return expand(readFileSync(entry, 'utf8'), entry, new Set([entry]));
}

function expand(text, fromPath, stack) {
  return text.split('\n').map(line => {
    const m = line.match(INCLUDE);
    if (!m) return line;
    const [, indent, rel] = m;
    const target = join(SRC, rel);
    if (!existsSync(target)) {
      throw new Error(`@include の参照先が存在しません: ${rel}\n  (${fromPath} から参照)`);
    }
    if (stack.has(target)) {
      throw new Error(`@include が循環しています: ${rel}`);
    }
    let body = readFileSync(target, 'utf8').replace(/\n$/, '');
    // 再帰展開（現状は1段だが、将来の分割に備える）
    body = expand(body, target, new Set([...stack, target]));
    return indent ? body.split('\n').map(l => (l ? indent + l : l)).join('\n') : body;
  }).join('\n');
}

/* ---------- CLI ---------- */
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const checkOnly = process.argv.includes('--check');
  let html;
  try {
    html = build();
  } catch (e) {
    console.error('ビルド失敗: ' + e.message);
    process.exit(1);
  }

  if (checkOnly) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
    if (current === html) {
      console.log('OK  game/midnightline.html はソースと一致しています。');
      process.exit(0);
    }
    console.error('NG  game/midnightline.html がソースと一致しません。');
    console.error('    `npm run build` で再生成してください。');
    process.exit(1);
  }

  writeFileSync(OUT, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`OK  game/midnightline.html を生成しました (${html.split('\n').length} 行 / ${kb} KB)`);
}
