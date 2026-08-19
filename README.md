# PLATEAU 交通空白地 PoC (Next.js + TypeScript + CesiumJS)

PLATEAU CityHack Challenge 2026 向けのPoCです。CesiumJS で PLATEAU の建物3D Tiles（LOD1）・地形を表示します。テーマは「藤沢市北部の交通空白地」（公共交通が手薄なエリアの可視化）です。姉妹プロジェクト`plateau-poc`（江の島・津波避難テーマ）で得た知見を最初から適用しています。Cesium ion のアカウント・トークンは不要です。

**現状は建物3D Tiles・地形・オルソ画像に加え、藤沢市北部（JR東海道線より北側）のバス停ピン（653件）を表示できます。** 鉄道駅、人口密度の代理指標（`bldg:usage`/`totalFloorArea`）、地形の傾斜データはまだ実装していません（詳細は`AGENTS.md`の「次にやるべきこと」参照）。

## セットアップ

```bash
npm install
npm run dev
```

`http://localhost:3000` を開くと、藤沢市北部のバス停ピン全体に自動フィットしたカメラで建物3Dモデルが表示されます。バス停ピンをクリックすると停留所名がポップアップ表示されます。

**バス停データについて**: 神奈川中央交通の正式なGTFS-JPデータはODPTの「公共交通オープンデータチャレンジ2026」限定ライセンス下にあり、そのチャレンジの申込期間（2026年10月1日〜）がまだ開始していないため、暫定的にOpenStreetMap（Overpass API）から抽出したデータ（`public/data/bus-stops.json`）を使っています。事業者名タグが欠けているノードが多い点に注意してください。詳細は`AGENTS.md`の「バス停データについて」を参照してください。

スマートフォン実機からLAN経由で開発サーバーを確認したい場合は、`next.config.ts`の`allowedDevOrigins`に自分の環境のLAN IPパターンが含まれているか確認してください（デフォルトで`192.168.*.*`と`10.*.*.*`をカバー済み）。

## 対象エリアを変える

`app/PlateauViewer.tsx` 先頭の自治体コードを書き換えるだけです。

```ts
const CITY_CODE = "14205"; // 総務省の全国地方公共団体コードに差し替え
```

自治体コードは総務省の「全国地方公共団体コード」一覧（https://www.soumu.go.jp/denshijiti/code.html）で調べられます。

`BUILDING_TILESET_URL` は `{自治体コード}-bldg-lod1-latest` の形式で組み立てているため、コードを変えるだけで別自治体の最新データに切り替わります。LOD2（テクスチャ付き詳細モデル）を使いたい場合は `datacatalog/plateau-datasets` API のレスポンスから該当自治体の `composite_url` を確認して直接差し替えてください。

カメラの初期位置（`INITIAL_VIEW`）も対象エリアに合わせて書き換えてください。

## 今後のデータ統合方針

1. **GTFS-JP（バス停・鉄道駅）**: 神奈川中央交通、または東京公共交通オープンデータチャレンジのカタログサイトから藤沢市北部をカバーするデータを入手し、`stops.txt` の緯度経度をピン表示する。
2. **人口密度の代理指標**: PLATEAU建物モデルの属性 `bldg:usage`（建物用途）と `totalFloorArea`（延床面積）から、エリアごとの居住密度を推定する。
3. **地形の傾斜データ**: PLATEAU-Terrainの標高値から傾斜を計算し、徒歩・自転車でのアクセスしやすさの評価に使う。

3種のデータを重ね合わせ、「公共交通のカバレッジが薄く、かつ人口密度がそれなりにあるエリア」を可視化することを目指します。詳細な進め方は `AGENTS.md` の「次にやるべきこと」を参照してください。

## 仕組みのポイント

- **地形**: `tile.plateauview.mlit.go.jp` の PLATEAU-Terrain を利用（Cesium ion 不要）
- **建物**: `api.plateauview.mlit.go.jp` の複合 tileset.json API を利用。`-latest` サフィックスで新年度データに自動追従
- **Next.js対応**: Next.js 16 はデフォルトで Turbopack のため、Cesium の静的アセット（Workers/Assets/Widgets）をコピーする `copy-webpack-plugin` を使う都合上、`dev`/`build` は `--webpack` フラグ付きで実行するようにしている（package.json 参照）。コピー先は `next dev`/`next build` の出力先の違いを避けるため `process.cwd()` 基準の絶対パスにしている（`next.config.ts`）
- Cesium は DOM/window に依存するため、`app/page.tsx` で `next/dynamic` の `ssr: false` を使ってクライアントのみで読み込んでいる
- Cesium標準の `infoBox`/`selectionIndicator` はViewer初期化時に無効化済み（バス停等の独自UIを実装した際に競合しないようにするため）
- 本番ビルド限定でCesiumバンドルがNextの内蔵minifierと衝突する既知の問題（詳細は`AGENTS.md`）に対応するため、`terser-webpack-plugin`でCesiumを再minify対象から除外する設定を最初から入れてある
