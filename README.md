# 写真台帳アプリ（統合版）

発掘調査の現場写真から看板（QR／手書き）を読み取り、看板ごとにグループ化して写真台帳（CSV／Excel）を出力し、写真のリネーム・フォルダ振り分けまで行う、単一HTMLのブラウザアプリです。

- **アプリ本体**：`index.html`（GitHub Pages で配信）
- **中継サーバー**：`server/`（手書き/高精度OCR用。Cloudflare Workers に別途デプロイ）
- **資料**：`docs/`（操作マニュアル・仕様書）

現在の版数は `CHANGELOG.md` を参照。

---

## フォルダ構成

```
（リポジトリ直下 ＝ GitHub Pages の公開ルート）
├── index.html                        アプリ本体（起動時にモード選択）
├── opencv.js                         QR検出の強化部品（index.html が ./ で参照）
├── tesseract.min.js / worker.min.js  端末内OCR（オフライン・QR不読時のフォールバック）
├── tesseract-core-simd-lstm.wasm(.js)
├── tessdata/                         OCR辞書（jpn / eng）
├── 看板識別QR_印刷シート.html         手書きモード用「識別QR（内容 "T1"）」印刷シート
├── marker_qr.png                     識別QRの単体画像（予備）
│
├── server/                           中継サーバー（★GitHub Pages では動かない）
│   ├── worker.js                     Cloudflare Workers 本体
│   └── wrangler.toml                 デプロイ設定（APIキーは書かない）
│
├── docs/                             資料（配信不要・人が読む用）
│   ├── 操作マニュアル.pdf / .html
│   ├── 仕様書.md
│   └── 改修内容 / 検証結果 / デバッグ報告
│
├── README.md                         このファイル
├── CHANGELOG.md                      版数の履歴
└── .gitignore
```

**重要**：`index.html` は同じ階層の `opencv.js` や `tesseract*` を相対パス（`./`）で読みます。**ルート直下の部品ファイルの名前・位置は変えないでください。**

---

## GitHub Pages への公開（アプリ本体）

1. このリポジトリの内容をそのまま push する。
2. リポジトリの **Settings → Pages** で、**Source = Deploy from a branch**、**Branch = main / (root)** を選ぶ。
   - ※ `docs/` フォルダはあくまで資料置き場です。Pages の Source を「/docs」にはしないでください（root のままで、`docs/` は配信されても害はありません）。
3. 数分後、`https://（ユーザー名）.github.io/（リポジトリ名）/` で開けます。これがアプリのURLです。

`server/` と `docs/` はリポジトリに含めても Pages はただの静的ファイルとして扱うだけで、実行はされません（＝置いておいても無害）。

---

## 中継サーバー（Cloudflare Workers）のデプロイ

手書き／高精度OCRを使うときだけ必要です（デジタル看板QRの読み取りだけなら不要）。

```
cd server
npx wrangler secret put GEMINI_API_KEY     # Google AI Studio のAPIキー
npx wrangler secret put ALLOW_ORIGIN        # 例: https://ユーザー名.github.io（末尾の / やパスは付けない）
npx wrangler deploy
```

- デプロイ後の Worker URL を、アプリの「中継URL設定」に登録します（`https://` 必須）。
- 安くしたい／無料枠を広げたいときは、`GEMINI_MODEL`（Text変数）に `gemini-2.5-flash-lite` などを設定。未設定時は `gemini-3.5-flash-lite → gemini-2.5-flash-lite → gemini-3.5-flash` の順で使用。
- 実際に使われているモデルは、OCR実行時のレスポンスヘッダ `X-OCR-Model` で確認できます。
- 詳細は `docs/仕様書.md` の「高精度クラウドOCR」を参照。

**APIキーは絶対にリポジトリに置かないこと。** 必ず Cloudflare のシークレット（`wrangler secret put`）に登録します。

---

## 現場スマホ用の入力アプリ（別リポジトリ）

デジタル看板のQRを作る現場スマホ用PWA「写しこみ看板 入力アプリ」は、**別リポジトリ（`utusikomi`）で別デプロイ**です。このリポジトリには含めません。

---

## バージョン管理の方針（散らからないコツ）

- **`_ver2.22_一式` のようなバージョン付きフォルダは作らない。** 作業フォルダは常にこの1つだけにします。
- 版を上げたら **git のコミット＋タグ** で記録します（例：`git tag v2.22 && git push --tags`）。
- 節目のまとまりは **GitHub の Releases** にすると、過去版のZIPも自動で残せます。
- 変更点は `CHANGELOG.md` に追記します。

これで「今どれが最新か分からない」状態がなくなります。

---

## リポジトリに含める／含めないもの

- **含める**：`index.html`・部品一式（opencv/tesseract/tessdata）・印刷シート・`server/`・`docs/`・README/CHANGELOG。
  - opencv や tessdata は数MBありますが、**オフライン動作に必要な部品なので一緒にコミット**します。
- **含めない**：APIキーなどの秘密情報（＝Cloudflareシークレットに置く）、`node_modules/`、OSの隠しファイル（`.DS_Store` 等）、`.wrangler/` 等の作業生成物。→ `.gitignore` 参照。

株式会社東京航業研究所　調査研究課
