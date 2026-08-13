# ミッドナイトライン ―澪原市いのちの電話―

電話相談サスペンス心理ホラーミステリー。
プレイヤーは澪原市の夜間電話相談員として、Day1〜14 の夜勤を受話器ひとつで乗り切る。
現場へは行けない。声・息づかい・物音・沈黙・雑音・話の矛盾だけが手がかり。

## 遊ぶ

`game/midnightline.html` をブラウザで開くだけ。依存も配信サーバも要らない。

```
git clone <このリポジトリ> && open game/midnightline.html
```

## リポジトリ構成

```
docs/
  design.md              完全設計書（企画側の一次資料）
  ENGINE.md              エンジン仕様書（実装から書き起こしたもの）
  GAP.md                 設計書と実装の差分一覧
src/
  index.html             ガワと <!-- @include --> の並び
  style.css
  core.js                DOM 非依存のロジック（状態・フラグ・判定）
  engine.js              描画・音響・資料パネル・入力・保存
  data/
    stills.js            スチル18枚の定義
    endings.js           エンディング5種の文面
  scenario/
    _init.js             SCENARIO の器
    pro.js ch1..ch5 fin.js   章ごとのノード配列（計 1237 ノード）
tools/
  build.mjs              src/ → game/midnightline.html
  load-core.mjs          core.js とシナリオを Node へ読み込む共通ローダ
  check.mjs              静的検査 + 全ルート自動プレイ
  regression.mjs         回帰テスト（過去の不具合を症状の形で固定）
  verify-browser.mjs     ヘッドレス検証と実ブラウザの照合
  playthrough.mjs        実ブラウザ通しプレイ + セーブ/ロード + 周回
  routes.json            各エンディングへの到達手順（回帰テスト用）
game/
  midnightline.html      ビルド成果物（単一ファイル）
```

## 開発

```bash
npm run build            # src/ から game/midnightline.html を生成
npm run check            # ビルド同期確認 + 回帰テスト + 静的検査 + ルート検証
npm run test:browser     # routes.json を実ブラウザで再生して照合（要 playwright）
npm run test:play        # 実ブラウザで画面を操作して通しプレイ（要 playwright）
npm run test:all         # 上記すべて
npm run check:record     # 探索したルートを routes.json に記録し直す
```

### 検証の三層

| 層 | ツール | 何を見るか |
|---|---|---|
| 静的 | `check.mjs` | ラベル・命令・キャラ・フラグの参照整合性、到達可能性 |
| 状態遷移 | `check.mjs` / `regression.mjs` | 本番の core.js を使って全ルートを自動プレイし、5エンディングへの到達性と過去バグの再発を確認 |
| 実操作 | `playthrough.mjs` / `verify-browser.mjs` | 実ブラウザで実際にボタンを押して最後まで遊べるか、セーブ/ロード・周回が壊れていないか |

上の層だけでは engine.js 側のバグを取り逃す。実際、`playRec` の周回バグは
実ブラウザ照合ではじめて見つかった。

ビルドはトランスパイルもバンドラも使わず、`<!-- @include path -->` を
ファイル内容に差し替えるだけ。出力は素の単一HTMLのまま維持される。

### なぜ core.js を分けているか

`tools/check.mjs` は全ルートを自動プレイしてエンディング到達性を検証するが、
そこで使う `cond()` / `applyData()` / `judge()` は **`src/core.js` を
そのまま読み込んで使っている**。検証側でノードの意味論を再実装すると、
エンジンを直しても検証が古い挙動を検証し続けることになるため。

`engine.js` 側にしか無い処理（`playRec` による録音フラグの再設定など）は
`tools/verify-browser.mjs` が実ブラウザ上で照合する。この二段構えで
実際にバグが 2 件見つかっている（`docs/GAP.md` §1 の 2 と 3）。

## シナリオを書き足すとき

ノード仕様は `docs/ENGINE.md` に全種類まとまっている。特に事故りやすいのは:

- `say` / `nar` / `sys` ノードは即 return するので、同じノードに書いた
  `set` などは**実行されない**
- `go` は `if` より先に評価されるので、同じノードに混在させない
- `day` は時刻を 22:00 に巻き戻す
- `sec`（制限時間）を付けたら `timeout:1` の選択肢を必ず用意する

これらは `npm run check` の静的検査がすべて検出する。
