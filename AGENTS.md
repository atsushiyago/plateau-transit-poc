<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# プロジェクト概要

PLATEAU CityHack Challenge 2026（藤沢市がメンター自治体）向けのアプリ。姉妹プロジェクト`plateau-poc`（江の島・津波避難テーマ）で得た知見をベースに、別テーマで新規に立ち上げたPoC。

**テーマ**: 藤沢市北部の「交通空白地」（公共交通が手薄なエリア）。バス停・鉄道駅（GTFS-JP）、建物属性（`bldg:usage`, `totalFloorArea`）による人口密度の代理指標、地形の傾斜データを組み合わせ、交通アクセスが悪いエリアをCesium上で可視化することを目指す。

**スタック**: Next.js 16 (App Router) + TypeScript + CesiumJS。Firebase/Vercelは未導入（必要になったら追加）。GitHub/Vercelへのデプロイも未実施（`plateau-poc`と異なり、まだローカル開発のみ）。

# 現在の実装状況

- `app/PlateauViewer.tsx`: Cesium Viewer本体（クライアント専用、`app/page.tsx`から`next/dynamic({ssr:false})`で読み込み）
- 藤沢市（自治体コード`14205`）の建物3D Tiles（LOD1）・PLATEAU-Terrain・PLATEAU-Orthoを表示
- **バス停ピン（`public/data/bus-stops.json`、653件）を実装済み。** 藤沢市北部（JR東海道線より北側）のバス停をオレンジ色のピンで表示し、クリックすると自前のInfoPopupで停留所名を表示する（事業者名タグがある場合のみ「事業者: ○○」も表示。無い場合は「事業者情報なし（OSMデータ）」）。データの出自・抽出方法は下記「バス停データについて」参照
- カメラはバス停ピン全体に自動フィット（`Cesium.BoundingSphere.fromPoints()` + `viewer.camera.flyToBoundingSphere`）。`viewer.flyTo(entities, ...)`は使っていない（理由は下記「ハマりどころ」参照）
- `viewer.scene.globe.baseColor`を`Cesium.Color.DARKSLATEGRAY`に設定済み。PLATEAU-Orthoは藤沢市北部で一部タイルが404になり抜けがあり、Cesiumのデフォルト地表色（青）のままだと抜けが「海」に見えて紛らわしいため（下記「ハマりどころ」参照）
- 建物属性（`bldg:usage`/`totalFloorArea`）による人口密度の代理指標、地形の傾斜データは**まだ実装していない**

# バス停データについて

神奈川中央交通のGTFS-JPは、ODPTの「公共交通オープンデータチャレンジ2026限定ライセンス」のAPIキーが必要で、そのチャレンジの申込期間が**2026年10月1日〜2027年1月11日**とまだ開始していない（2026年8月時点）ため、暫定的にOpenStreetMap（Overpass API）から抽出したデータを使っている。

- 抽出条件: `highway=bus_stop` / `public_transport=platform`+`bus=yes` / `amenity=bus_station`のノードを、藤沢市の行政区域内から取得
- 「北部」の判定: OverpassでJR東海道本線（`railway=rail`, `name=東海道本線`）のwayジオメトリも取得し、各バス停の経度における路線の緯度を線形補間で求め、バス停の緯度がそれを上回れば「北側」と判定（藤沢市内で東海道本線はほぼ東西に走っているため、この程度の簡易判定で十分。`isOnLand`の陸地判定と同じ「対象エリアが限定的なので全国精度は不要」という方針）
- 事業者名（`operator`タグ）が付いているノードは653件中72件のみ（残りは`null`）。OSMのタグ付けが不完全なため、`operator`の有無でフィルタせず藤沢市北部の全バス停を対象にしている
- 抽出・変換に使ったスクリプトはリポジトリに残していない（その場でPythonワンショットで処理したため）。再実行する場合は同じOverpassクエリ（下記）を使うこと:
  ```
  [out:json][timeout:60];
  area["name"="藤沢市"]["boundary"="administrative"]->.a;
  (
    node["highway"="bus_stop"](area.a);
    node["public_transport"="platform"]["bus"="yes"](area.a);
    node["amenity"="bus_station"](area.a);
  );
  out body;
  ```
- **10月以降、ODPTのChallenge 2026アクセストークンが取得可能になったら、GTFS-JPの正式データ（`odpt:BusstopPole`、`https://api-challenge.odpt.org/api/v4/odpt:BusstopPole?odpt:operator=odpt.Operator:Kanachu`）に差し替えることを検討する。** OSMデータは事業者名の欠落が多く、路線・時刻表情報も持たないため、交通空白地の分析（バス便数を考慮した実質的なアクセス性評価など）にはGTFS-JPの正式データの方が適している。

# 次にやるべきこと

1. ~~GTFS-JPデータの入手・パース~~ → 上記の通りOSMデータで暫定実装済み。10月以降に正式データへの差し替えを検討。鉄道駅のピンはまだ未実装。
2. **人口密度の代理指標**: PLATEAU建物モデルの属性`bldg:usage`（建物用途、住宅系かどうか）と`totalFloorArea`（延床面積）を使い、エリアごとの居住密度を推定する。3D Tilesの`Cesium3DTileFeature`から属性を取得する必要がある（LOD1でこれらの属性が含まれているか要確認。含まれていない場合はLOD2への切り替えが必要かもしれない）。
3. **地形の傾斜データ**: PLATEAU-Terrainの標高値から傾斜を計算し、徒歩・自転車でのアクセスしやすさの評価に使う。Cesiumの`sampleTerrainMostDetailed`等で標高をサンプリングする方法を検討。
4. 上記2種のデータとバス停データを重ね合わせ、「公共交通のカバレッジが薄く、かつ人口密度がそれなりにあるエリア」を可視化するロジック（バス停からの距離バッファ等）を設計する。
5. バス停が653件と多く常時ラベル表示していないため、ズームレベルに応じたラベル表示やクラスタリングを検討してもよい（`plateau-poc`の`SHELTER_LABEL_MAX_DISTANCE`と同様の距離連動表示など）。

# ハマりどころ（`plateau-poc`から持ち越し。既に解決済み、再発防止用）

- **CesiumのデフォルトのSky/背景画像はCesium ion依存**。ionトークンなしで使うと"An error occurred while rendering. Rendering has stopped."になる。→ `baseLayer`にPLATEAU-Ortho（`tile.plateauview.mlit.go.jp/tiles/plateau-ortho-2023/{z}/{x}/{y}.png`、ion不要）を明示的に指定して回避している（実装済み）。
- **PLATEAU-TerrainのURL**は`https://tile.plateauview.mlit.go.jp/terrain`が正しい（layer.jsonのベースパスまで）。年度サフィックス（`plateau-terrain-2023`のような）を付けると404になる。オルソ画像の命名規則と混同しないこと。
- **`next.config.ts`のcopy-webpack-plugin**で、CesiumのWorkers/Assets/Widgets/ThirdPartyを`public/cesium`にコピーする際、コピー先を相対パス（`../public/cesium`）にすると`next dev`と`next build`で出力先ディレクトリが異なるため、`next dev`時に404になる。**`process.cwd()`基準の絶対パスを使うこと**（現在の実装は対応済み）。
- Next.js 16はデフォルトTurbopackだが、copy-webpack-pluginを使う都合上`dev`/`build`スクリプトに`--webpack`フラグを付けている（package.json参照）。
- **独自のクリックハンドラを`viewer.scene.canvas`に追加しても、Cesium Viewerが内部で持つデフォルトのクリック選択（selectionIndicator/infoBoxを表示する）は別の`ScreenSpaceEventHandler`インスタンスとして動き続けるため競合する。** バス停・駅などの独自ポップアップUIを実装する前提で、Viewer初期化オプションに最初から`infoBox: false, selectionIndicator: false`を指定してこれらのウィジェット自体を作らせないようにしている（`plateau-poc`で、3D Tiles建物フィーチャーをクリックすると生の属性がそのまま表示される問題や、selectionIndicatorがクリック地点とズレる問題が起きたことの再発防止）。情報表示は自前のReactステートで行うこと。
- **`viewer.flyTo(entities, ...)`に`clampToGround`や`HeightReference.CLAMP_TO_GROUND`のエンティティを直接渡すと、地形の読み込みが遅い/失敗する環境でハングすることがある**（Cesium内部の`updateZoomTarget`が全エンティティのバウンディングスフィアが`DONE`になるまで待ち続け、タイムアウトが無いため）。→ 点データを追加してカメラ自動フィットを実装する際は、`viewer.flyTo`ではなく、各エンティティの生の頂点座標から`Cesium.BoundingSphere.fromPoints()`で自前にバウンディングスフィアを計算し、`viewer.camera.flyToBoundingSphere(sphere, {offset})`で移動すること。
- **本番ビルド（`next build`）限定で、CesiumのバンドルをNextの内蔵minifierが二重にminifyすると"SyntaxError: Octal escape sequences are not allowed in template strings."が発生する**（`plateau-poc`をVercelにデプロイした際に発覚。CesiumのバンドルにはWASMバイナリを8進数エスケープ文字列として埋め込んだ箇所があり、テンプレートリテラルへの変換で構文エラーになる）。→ `next.config.ts`で`terser-webpack-plugin`を自前インストールし、`config.optimization.minimizer`を`exclude: /node_modules[\\/]cesium[\\/]/`で差し替え済み（このプロジェクトは最初からこの対策を入れてある）。**デプロイする際は必ず`npm run build && npm start`でローカルの本番ビルドを実際にブラウザで確認すること**（`next dev`だけでは検知できない）。
- **PLATEAU-Orthoは全国均一の解像度・カバレッジではない。** `plateau-poc`（江の島・沿岸部）では隙間なく表示できていたが、このプロジェクトの対象エリア（藤沢市北部、内陸部）ではズームレベルによって一部タイルが404を返し、その部分だけ画像が抜ける（ブラウザのネットワークタブで`plateau-ortho-2023/{z}/{x}/{y}.png`が200と404の両方を返しているのを確認済み）。Cesiumはタイル取得に失敗すると`scene.globe.baseColor`（デフォルトは青）を透過させて表示するため、何も知らずに見ると抜けた部分が「海」に見えて紛らわしい。→ `viewer.scene.globe.baseColor = Cesium.Color.DARKSLATEGRAY`のように中立色に変更し、「データがない」ことが視覚的に分かるようにしている。根本的な解決（抜けの穴埋め）はPLATEAU側のデータ次第なので対応不可。

# PLATEAU配信サービスの主要エンドポイント

- 建物3D Tiles（複合tileset.json、自治体コード+`-latest`で最新年度に自動追従）: `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/{cityCode}-bldg-lod1-latest/tileset.json`
- 地形（ion不要）: `https://tile.plateauview.mlit.go.jp/terrain`
- オルソ画像（ion不要）: `https://tile.plateauview.mlit.go.jp/tiles/plateau-ortho-2023/{z}/{x}/{y}.png`
- 公式ドキュメント: https://docs.plateauview.mlit.go.jp/
