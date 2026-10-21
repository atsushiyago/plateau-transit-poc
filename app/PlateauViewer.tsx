"use client";

import { WALK_PROFILES, DISTANCE_MODEL_DEFAULT, haversineMeters, projectToLocalMeters, unprojectFromLocalMeters, kMeans, BUILDING_NETWORK_SCORES_JSON_URL, type WalkProfile, type DistanceModel, type BuildingNetworkScoreRow, type DemandTransitPlanAnalysis, type DemandTransitMember, type DemandTransitPlanSite } from "./lib/transit-analysis";
import { TileWorkGate } from "./lib/async-generation";
import type { AnalysisResponse } from "./workers/transit-analysis.worker";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Cesium from "cesium";

// 表示したい自治体コード（14205 = 神奈川県藤沢市）。
// 総務省の全国地方公共団体コード表で他の自治体コードに差し替え可能。
// https://www.soumu.go.jp/denshijiti/code.html
const CITY_CODE = "14205";

// 複合tileset.json API: 自治体コード + "-latest" で最新整備年度のLOD1建物データに自動追従する。
const BUILDING_TILESET_URL = `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${CITY_CODE}-bldg-lod1-latest/tileset.json`;

// PLATEAU-Terrain（Cesium ionトークン不要で利用可能）
// 注意: layer.json は https://tile.plateauview.mlit.go.jp/terrain/layer.json にあり、
// ベースURLは "/terrain" まで（オルソ画像のような年度サフィックスは付かない）
const TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain";

// PLATEAU-Ortho（航空写真オルソ画像。こちらもionトークン不要）
// Cesium.Viewer はデフォルトでCesium ion経由の衛星画像を背景に使おうとするため、
// ionトークンを設定しない場合はここを明示的に差し替えないとレンダリングが止まる。
const ORTHO_URL = "https://tile.plateauview.mlit.go.jp/tiles/plateau-ortho-2023/{z}/{x}/{y}.png";

// バス停データ（藤沢市北部、JR東海道線より北側のみ、337件）。
// 【正式決定・データソース切替済み】当初はOpenStreetMap（Overpass API）由来のデータを暫定的に
// 使っていたが、事業者名タグの欠落が多い（653件中72件のみ）という制約があったため、国土数値情報
// 「バス停留所データ（P11、第3.0版、2022年度）」に切り替えた。P11は全国のバス停すべてに
// バス事業者名（コミュニティバスは自治体名）が付与されているため、事業者不明のバス停が存在しない。
// 神奈川中央交通のGTFS-JP自体は引き続き「公共交通オープンデータチャレンジ2026」限定ライセンスの
// APIキーが必要で、申込期間（2026年10月1日〜）がまだ開始していないため入手不可能（詳細はAGENTS.md参照）。
const BUS_STOPS_JSON_URL = "/data/bus-stops.json";

const BUS_STOP_COLOR = Cesium.Color.fromCssColorString("#f59e0b");
const BUS_STOP_PIXEL_SIZE = 10;
// 神奈川中央交通以外（コミュニティバス等、下記MAJOR_OPERATOR_KEYWORDSに一致しない事業者）の
// バス停は参考表示として残しつつ、視覚的に控えめにする（「どのピンが実効距離の計算に
// 使われているか」が見た目で分かるようにする）。
// 当初は同じ#f59e0bを透明度35%にして小さく表示していたが、Cesiumのpointは背景（建物の色・
// 地表色）と実際に合成されるため、赤い建物の上では暗く沈み、白い建物の上では薄く白っぽく、
// 何もない地表（ortho画像未読み込み/欠損時のフォールバック色）の上では灰色がかって見えるなど、
// 背景次第で色がバラついて見える問題があった。→ 不透明な淡いアンバー色に変更し、背景に関わらず
// 一定の見た目になるようにした。主要事業者と同じサイズにしつつ、色相は保って
// 「同じ系統だがその他事業者」と分かるようにしている。
const BUS_STOP_COLOR_MINOR = Cesium.Color.fromCssColorString("#fde68a");
const BUS_STOP_PIXEL_SIZE_MINOR = BUS_STOP_PIXEL_SIZE;

// 起動時の初期カメラ表示範囲（ユーザー指定の中心点・半径・角度）。
const INITIAL_VIEW_CENTER_LNG = 139.44893;
const INITIAL_VIEW_CENTER_LAT = 35.365;
const INITIAL_VIEW_RADIUS_METERS = 1213;
const INITIAL_VIEW_HEADING = 350;
const INITIAL_VIEW_PITCH = -34.7;

// 実効距離（アクセシビリティスコア）の計算に使う「主要事業者」の判定キーワード。
// P11データのバス事業者名（P11_002）は藤沢市北部エリアでは「神奈川中央交通（株）」の表記で
// 統一されている（表記ゆれ無し。実データで確認済み）が、将来のデータ更新で法人格表記
// （（株）の位置等）が変わる可能性を考慮し、部分一致で判定する。
const MAJOR_OPERATOR_KEYWORDS = ["神奈川中央交通"];
function isMajorOperatorStop(stop: BusStop): boolean {
  return MAJOR_OPERATOR_KEYWORDS.some((keyword) => stop.operator.includes(keyword));
}

type BusRoute = { name: string; classCode: string | null };
type BusStop = { name: string; lat: number; lng: number; operator: string; routes: BusRoute[] };

// 分析用施設はanalysis-facilities.json。市境・東海道線で利用先を切らない。
type TrainStation = { name: string; lat: number; lng: number };

// 藤沢市公式の「交通空白地」定義（メンター自治体への質問への回答で確認済み、2026年8月）:
// 「鉄道駅から600m圏、バス停から300m圏（高齢者の移動を考慮した基準）に入らないエリア」。
// このPoCでは傾斜込みの実効距離をこの2つの閾値と比較し、どちらか一方でも満たせば
// 「カバーされている」と判定する（OR条件）。詳細はAGENTS.md「藤沢市の距離基準を参考にした独自推計への
// 切替について」参照。
const STATION_COVERAGE_THRESHOLD_METERS = 600;
const BUS_COVERAGE_THRESHOLD_METERS = 300;

// 藤沢市内でJR東海道本線はほぼ東西に走っているため、経度ごとに路線の緯度を線形補間し、
// 建物の緯度がそれを上回れば「北側」と判定する簡易ロジック（バス停データの北部抽出時と同じ考え方。
// 対象エリアが限定的なので全国精度は不要という`isOnLand`的な方針を踏襲）。
// 元データはOverpass APIのJR東海道本線wayジオメトリ（241点）を61点に間引いたもの（最大誤差約14m）。
const TOKAIDO_LINE_JSON_URL = "/data/tokaido-line.json";

// 建物属性`bldg:usage`にこの文字列を含む場合を住宅系とみなす（共同住宅・住宅・店舗等併用住宅・
// 店舗等併用共同住宅など、PLATEAU仕様の用途区分は「住宅」を含む表記に統一されているため）。
const RESIDENTIAL_USAGE_SUBSTRING = "住宅";

// 傾斜込みアクセシビリティスコアを計算する住宅系建物の上限数。全建物を処理すると
// 地形サンプリング(sampleTerrainMostDetailed)の呼び出しが増えて重くなるため上限を設ける。
// この上限はグローバル・恒久的（一度使い切ると解放されない）なので、低すぎると
// 「最初にタイルが読み込まれたエリア（初期カメラが広域なため、たまたま先に読み込まれた
// エリア）だけが色付けされ、それ以外のエリアはいつまで待っても色付けされない」という
// 分かりにくい不具合になる（1200だった当初これが実際に発生した。詳細はAGENTS.md参照）。
// 藤沢市全体の建物3D Tilesは約700タイルで、住宅系×北部に絞ればこの値に達することは
// まず無い想定だが、将来的に上限に達するようなら「カメラから遠い建物のキャッシュを
// 間引く」等のエビクション戦略への切り替えを検討すること。
const MAX_SCORED_BUILDINGS = 80000;
// 建物〜最寄りバス停の直線を何点でサンプリングして傾斜を求めるか（区間数はこの値-1）。
const SLOPE_SAMPLE_COUNT = 5;
// 地形データのノイズで極端な勾配が出た場合の上限（40%勾配で頭打ち）。プロファイルに関わらず共通。
const SLOPE_GRADIENT_CAP = 0.4;

// 勾配への感度・歩行速度を「一般」「高齢者（坂道に配慮）」の2プロファイルで切り替えられるようにする。
// 【追加の経緯】メンター自治体（藤沢市、丹野氏）から「北部エリアは高齢化率が加速している地域なので、
// 年齢層に応じた交通空白地の考え方（高低差の重み付け）があってよいのでは」という提案を受けて実装。
// 【重要な注記】ここの係数は医学的・工学的な実測値に基づくものではなく、あくまで目安の設定である:
// - walkSpeedMPerMin: 高齢者の分速50m（時速3km）は、バリアフリー設計で参考にされることが多い一般的な値
// - slopePenaltyFactor: 「坂道への負荷が一般よりも大きい」という定性的な方向性を、一般の2倍という
//   単純な係数で表現しただけで、根拠となる調査データがあるわけではない
// 実務利用の際は、藤沢市側の知見（バス・鉄道担当者と共有予定とのこと）を踏まえて調整することを想定している。
const WALK_PROFILE_DEFAULT: WalkProfile = "general";

// 【feature/road-network-distanceブランチ限定・実験的】直線距離モデル（デフォルト、mainと同じ
// ライブ計算）と、道路網距離モデル（scripts/road-network/で事前計算したbuilding-network-scores.json
// を読み込むだけ）を、ブラウザ上で切り替えて見比べられるようにするためのトグル。
// ユーザーから「別ブランチで動かしたら空白地の色付けがどれくらい変わるのか見たい」との要望を受けて、
// mainとブランチを行き来せず同じ画面上で比較できるよう追加した（あくまで視覚比較用の一時的な
// 実装であり、本採用するかどうかは別途判断する）。
// 【feature/road-network-distanceブランチ限定・実験的】道路網距離は直線距離より系統的に長くなる
// ため、直線距離モデルと同じ300m/600mの閾値をそのまま道路網距離に適用すると判定が「厳しすぎる」
// のでは、という丹野氏からの指摘（2026年8月）を受けて追加。道路網距離モデルの閾値にだけ
// 調整可能な倍率をかけられるようにする（直線距離モデルは藤沢市公式定義との比較用の
// ベースラインとして、常に固定の300m/600mのまま変更しない）。
const NETWORK_THRESHOLD_MULTIPLIER_DEFAULT = 1.2;

// 建物ごとの「カバー率」= min(バス実効距離/BUS_COVERAGE_THRESHOLD_METERS, 駅実効距離/
// STATION_COVERAGE_THRESHOLD_METERS)。閾値の単位（300m/600m）が異なる駅・バスの2つの基準を
// ORで比較するための正規化で、ratio<=1ならどちらか一方の基準を満たす＝「カバーされている」。
// 【2026年8月・3段階に統合】当初はratio>1の超過分を赤系4段階（僅かに超過/やや遠い/遠い/
// 非常に遠い）に分けていたが、実データで集計したところ「やや遠い」「遠い」に該当する建物は
// 合わせて全体の6.3%しかなく（僅かに超過12.7%・非常に遠い0.2%に対して桁が違う）、実機で
// 見ても2色（僅かに超過の薄いピンクと、非常に遠いの暗い赤）にほとんどのケースが収まって見え、
// 中間2色にはめったに遭遇しないという指摘を受けた。中間2段階を「非常に遠い」側に統合し、
// 緑1色＋赤系2段階（僅かに超過/非常に遠い）のシンプルな構成にした。
const COVERAGE_RANKS: { maxRatio: number; legendLabel: string; color: Cesium.Color }[] = [
  { maxRatio: 1, legendLabel: "カバーされている", color: Cesium.Color.fromCssColorString("#22c55e") },
  { maxRatio: 1.5, legendLabel: "空白地（僅かに超過）", color: Cesium.Color.fromCssColorString("#fecaca") },
  { maxRatio: Infinity, legendLabel: "空白地（非常に遠い）", color: Cesium.Color.fromCssColorString("#7f1d1d") },
];

function colorForCoverageRatio(ratio: number): Cesium.Color {
  const rank = COVERAGE_RANKS.find((r) => ratio <= r.maxRatio) ?? COVERAGE_RANKS[COVERAGE_RANKS.length - 1];
  return rank.color;
}


function lineLatAtLon(points: [number, number][], lon: number): number {
  if (lon <= points[0][0]) return points[0][1];
  if (lon >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 0; i < points.length - 1; i++) {
    const [lon1, lat1] = points[i];
    const [lon2, lat2] = points[i + 1];
    if (lon1 <= lon && lon <= lon2) {
      if (lon2 === lon1) return (lat1 + lat2) / 2;
      const t = (lon - lon1) / (lon2 - lon1);
      return lat1 + t * (lat2 - lat1);
    }
  }
  return points[points.length - 1][1];
}

function isNorthOfTokaidoLine(points: [number, number][], lng: number, lat: number): boolean {
  if (points.length === 0) return false;
  return lat > lineLatAtLon(points, lng);
}

type BuildingScoreInfo = {
  usage: string;
  lat: number;
  lng: number;
  nearestStopName: string;
  busStraightDistanceMeters: number;
  busEffectiveDistanceMeters: number;
  busWalkMinutes: number;
  nearestStationName: string;
  stationStraightDistanceMeters: number;
  stationEffectiveDistanceMeters: number;
  stationWalkMinutes: number;
  coverageRatio: number;
  isCovered: boolean;
  totalFloorArea: number | null;
  walkProfileLabel: string;
};

// 乗り場増設案の比較結果。候補地点を一つずつクリックしなくても、追加数ごとの
// 改善度を確認できるようにする。
// 2点間の傾斜込み実効距離を計算する共通ロジック。住宅系建物の色分け（最寄りバス停まで）と、
// デマンド交通乗り場候補の「もしここに乗り場を新設したら」の再計算の両方で使う
// （後者は単に目的地を既存バス停群からクラスタ重心に差し替えて同じ関数を呼ぶだけでよい）。
type EffectiveDistancePair = { originLat: number; originLng: number; destLat: number; destLng: number };
type EffectiveDistanceResult = { straightDistanceMeters: number; effectiveDistanceMeters: number };

async function computeEffectiveDistances(
  terrainProvider: Cesium.TerrainProvider,
  pairs: EffectiveDistancePair[],
  slopePenaltyFactor: number
): Promise<EffectiveDistanceResult[]> {
  const straightDistances = pairs.map((p) => haversineMeters(p.originLat, p.originLng, p.destLat, p.destLng));

  // 各ペアの直線をSLOPE_SAMPLE_COUNT点でサンプリングし、まとめて1回のsampleTerrainMostDetailedで
  // 標高を取得する（ペアごとに個別に呼ぶとリクエストが増えて遅くなるため）。
  const allSamples: Cesium.Cartographic[] = [];
  const sampleRanges: [number, number][] = [];
  pairs.forEach((p) => {
    const start = allSamples.length;
    for (let s = 0; s < SLOPE_SAMPLE_COUNT; s++) {
      const t = s / (SLOPE_SAMPLE_COUNT - 1);
      const lng = p.originLng + (p.destLng - p.originLng) * t;
      const lat = p.originLat + (p.destLat - p.originLat) * t;
      allSamples.push(Cesium.Cartographic.fromDegrees(lng, lat));
    }
    sampleRanges.push([start, start + SLOPE_SAMPLE_COUNT]);
  });

  const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, allSamples);

  return pairs.map((_, idx) => {
    const straightDistanceMeters = straightDistances[idx];
    const [start, end] = sampleRanges[idx];
    const heights = sampled.slice(start, end).map((carto) => carto.height);
    if (heights.some(height => !Number.isFinite(height))) throw new Error("地形の標高が欠測しています");
    const segmentDistance = straightDistanceMeters / (SLOPE_SAMPLE_COUNT - 1);
    let effectiveDistanceMeters = 0;
    for (let k = 0; k < heights.length - 1; k++) {
      const rise = Math.abs(heights[k + 1] - heights[k]);
      const gradient = Math.min(rise / Math.max(segmentDistance, 1), SLOPE_GRADIENT_CAP);
      effectiveDistanceMeters += segmentDistance * (1 + slopePenaltyFactor * gradient);
    }
    return { straightDistanceMeters, effectiveDistanceMeters };
  });
}

// デマンド交通乗り場候補は、藤沢市公式の交通空白地判定（COVERAGE_RANKS参照）でカバーされていない
// 住宅系建物を対象にする。候補抽出の母集団は公式基準の1.0倍に固定する。以前は「深刻度」を
// 絞り込むスライダーを設けていたが、比較分析の実効距離基準と意味が近く、操作軸が増えて
// 分かりにくくなるため廃止した。
const DEMAND_TRANSIT_GAP_RATIO_THRESHOLD = 1.0;
const DEMAND_TRANSIT_CLUSTER_COUNT_DEFAULT = 4;
// 比較分析では、実効距離に対してバス300m・駅600mをそのまま適用するか、坂道等による
// 上乗せを見込んで何倍まで許容するかを別途選べるようにする。これは地図の独自推計を
// 変えるものではなく、乗り場追加案の感度分析専用の条件である。
// 徒歩経路の一般的な迂回率（約1.2）を、比較分析の初期条件に採用する。
const DEMAND_TRANSIT_ANALYSIS_THRESHOLD_MULTIPLIER_DEFAULT = 1.2;
// クラスタリング対象の建物数がこれ未満なら候補地点を出さない（サンプルが少なすぎて
// 「クラスタ」と呼べる状態にならないため）。
const DEMAND_TRANSIT_MIN_BUILDINGS = 8;
// 建物のスコア計算が進むたびに毎回再クラスタリングすると重いので、最後の更新から
// このミリ秒だけ間隔が空いたら再計算する（デバウンス）。
const DEMAND_TRANSIT_RECOMPUTE_DEBOUNCE_MS = 1500;
const DEMAND_TRANSIT_COLOR = "#a855f7";

// 地図上の位置関係を土地勘なしでも把握できるようにするための、藤沢市北部の駅・地区名ラベル。
// 当初は8件をソース直書きしていたが、「もっと各所に地名を表示したい」というフィードバックを受けて
// バス停・東海道線データと同じOverpass抽出パターンに切り替えた（詳細はAGENTS.md参照）。
// 駅（railway=station/halt）と地区名（place=neighbourhood/quarter、丁目サフィックスを除去して
// 大字・地区単位に統合、既存のisNorthOfTokaidoLineと同じロジックで北部のみに絞り込み済み）を
// Overpassでまとめて抽出し、public/data/place-labels.json に保存してある。
const PLACE_LABELS_JSON_URL = "/data/place-labels.json";
type PlaceLabel = { name: string; lat: number; lng: number };

// 藤沢市が既に運行している乗合タクシー・オンデマンドバス（天神町AIオンデマンドバス、のりあい善行）を、
// このPoCが提案する「デマンド交通乗り場候補」（紫の四角ピン）と区別できる形で地図上にオーバーレイ
// 表示する。「このPoCは市の既存の取り組みと無関係に候補を出しているのではなく、市がまだ手を
// 付けていない場所を見つけるための優先順位付けツールである」ことを示すための機能。
// 【2026年8月・実際の停留所群を使う方式に変更】当初は各サービスにつき1点（中心座標・半径から
// 算出した概算エリア）のみを表示していたが、「実際にはいくつも停留所があるはずなのに1つしか
// 表示されていないのでは」という指摘を受けて見直した。調べたところ、天神町AIオンデマンドバス
// （既存の路線バス「天神町循環線」をAIオンデマンド化したもの）は`public/data/bus-stops.json`内の
// 「天神町」始まりの停留所10件（神奈川中央交通）として、のりあい善行も同ファイル内の事業者名
// 「善行地区郷土づくり推進会議」の17件として、**どちらも国土数値情報P11データにそのまま
// 実在する**ことが分かった（のりあい善行の公式路線図PDFと突き合わせ、01系統8件・02系統11件
// ＝重複除く17件の停留所名が完全一致することを確認済み）。そのため、概算の中心・半径を
// 算出する必要が無くなり、`public/data/existing-demand-transit.json`の各サービスに実際の
// 停留所一覧（`stops`）をそのまま持たせる方式に変更した。
// 【同時に対応済み】「おでかけ六会」は2024年11月29日をもって収支悪化により運行終了（ユーザー
// からの報告。藤沢市の地域公共交通ページ・のりあい善行ページのいずれにも記載が無くなっている
// ことをWeb検索で確認したが、終了を明記した一次情報＝正式な告知文までは見つけられていない）。
// 運行終了済みのサービスを現役のオーバーレイとして表示し続けるのは誤解を招くため、データから削除した。
const EXISTING_DEMAND_TRANSIT_JSON_URL = "/data/existing-demand-transit.json";
type ExistingDemandTransitStop = { name: string; lat: number; lng: number };
type ExistingDemandTransitService = {
  name: string;
  type: string;
  operator: string;
  startDate: string;
  description: string;
  sourceUrl: string;
  stops: ExistingDemandTransitStop[];
};
const EXISTING_DEMAND_TRANSIT_COLOR = Cesium.Color.fromCssColorString("#3b82f6");

// ハローサイクリング（OpenStreet株式会社）のシェアサイクルステーションを地図上に表示する。
// データ出典: ODPT（公共交通オープンデータセンター）のGBFS形式データ。GTFS-JPと違い
// 「公共交通オープンデータチャレンジ2026限定ライセンス」の対象外で、通常のODPTセンター
// アクセストークンで取得できる常時公開データ（詳細はREADME.mdのクレジット表記参照）。
// ライセンス: CC BY 4.0 / ODC BY 1.0 / ODbL 1.0。
// アクセストークンをクライアントに露出させないよう、/api/hellocycling-stations
// （サーバーサイドプロキシ）経由で取得する。北部エリアへの絞り込み（バウンディングボックス＋
// 東海道線より北）もこのAPIルート側で行っている。
// 【現段階のスコープ】表示のみで、coverageRatio等の色分けロジックには組み込んでいない
// （ユーザーからの明示的な指示）。
const HELLO_CYCLING_STATIONS_API_URL = "/api/hellocycling-stations";
type HelloCyclingStation = { id: string; name: string; lat: number; lng: number; capacity: number | null };
const HELLO_CYCLING_COLOR = "#facc15";

// 対象エリアが藤沢市北部（東西南北とも十数km程度）に限られるため、緯度経度を
// 単純な等距円筒図法でメートル相当のローカルXY座標に変換して使う（k-meansのユークリッド距離が
// 経度方向で不当に圧縮/伸長されるのを避けるため。全国精度は不要という他の判定と同じ方針）。
function createSquareIconDataUrl(fillColor: string, size = 28): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = fillColor;
  ctx.fillRect(3, 3, size - 6, size - 6);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(3, 3, size - 6, size - 6);
  return canvas.toDataURL();
}

// 既存の乗合タクシー・オンデマンドバスの拠点ピンを、デマンド交通候補（紫の四角）・バス停（丸だが
// 小さい）と見た目で区別するため、円形のアイコンを生成する（四角=このPoCの提案、丸=市の既存実績、
// という視覚的な対比を意図している）。
function createCircleIconDataUrl(fillColor: string, size = 28): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const center = size / 2;
  const radius = size / 2 - 3;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  return canvas.toDataURL();
}

// ハローサイクリングのステーションピンを、バス停（丸）・既存デマンド交通（青丸）と見た目で
// 区別するため、黄色い円に自転車の絵文字を重ねたアイコンを生成する。
function createBicycleIconDataUrl(fillColor: string, size = 28): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const center = size / 2;
  const radius = size / 2 - 3;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `${Math.round(size * 0.6)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🚲", center, center + 1);
  return canvas.toDataURL();
}

type PopupInfo = { title: string; lines: ReactNode[] };

// Cesium標準のinfoBox/selectionIndicatorは無効化している（下記Viewer初期化オプション参照）ため、
// バス停クリック時の情報表示はこの自前ポップアップで行う。
function InfoPopup({ info, onClose }: { info: PopupInfo; onClose: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        zIndex: 15,
        background: "rgba(20, 20, 20, 0.9)",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: 6,
        fontSize: 13,
        lineHeight: 1.6,
        fontFamily: "sans-serif",
        maxWidth: 320,
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
        border: "1px solid rgba(255, 255, 255, 0.15)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: "bold" }}>{info.title}</div>
        <button
          onClick={onClose}
          aria-label="閉じる"
          style={{
            background: "none",
            border: "none",
            color: "#fff",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      {info.lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

function Legend({
  clusterCount,
  analysisThresholdMultiplier,
  showHelloCycling,
  walkProfile,
  distanceModel,
  loadingNetworkScores,
  networkThresholdMultiplier,
  showExperimentalDistanceModel,
  onClusterCountChange,
  onAnalysisThresholdMultiplierChange,
  onShowHelloCyclingChange,
  onWalkProfileChange,
  onDistanceModelChange,
  onNetworkThresholdMultiplierChange,
  onToggleExperimentalDistanceModel,
  isDemandTransitAnalysisRunning,
  isDemandTransitPanelVisible,
  onShowDemandTransitPanel,
}: {
  clusterCount: number;
  analysisThresholdMultiplier: number;
  showHelloCycling: boolean;
  walkProfile: WalkProfile;
  distanceModel: DistanceModel;
  loadingNetworkScores: boolean;
  networkThresholdMultiplier: number;
  showExperimentalDistanceModel: boolean;
  onClusterCountChange: (value: number) => void;
  onAnalysisThresholdMultiplierChange: (value: number) => void;
  onShowHelloCyclingChange: (value: boolean) => void;
  onWalkProfileChange: (value: WalkProfile) => void;
  onDistanceModelChange: (value: DistanceModel) => void;
  onNetworkThresholdMultiplierChange: (value: number) => void;
  onToggleExperimentalDistanceModel: (value: boolean) => void;
  isDemandTransitAnalysisRunning: boolean;
  isDemandTransitPanelVisible: boolean;
  onShowDemandTransitPanel: () => void;
}) {
  // 折りたたみ見出しのホバー時ハイライト用。クリック可能であることを視覚的に伝えるため
  // （見出しだけを見てもクリックできると分かりにくい、という指摘への対応）。
  const [experimentalHeaderHovered, setExperimentalHeaderHovered] = useState(false);
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        top: 12,
        zIndex: 10,
        background: "rgba(20, 20, 20, 0.75)",
        color: "#fff",
        padding: "10px 12px",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: "sans-serif",
        // デマンド交通の閾値・候補数スライダーを操作できるようにする必要があるため、
        // UncoloredBuildingsNote等の純粋な装飾パネルとは異なりpointerEventsを有効にしている
        // （画面左上の固定サイズの小さな箱の中だけなので、他の地図操作の妨げにはならない）。
        pointerEvents: "auto",
        // maxWidthを明示しないと、幅制約の無い長文（距離モデルの説明文など）を子要素に
        // 追加したときに、absolute配置のshrink-to-fit計算でパネル全体が画面横幅いっぱいまで
        // 広がってしまう不具合が実際に発生した。他のパネル（InfoPopup/CoverageStatsPanel）と
        // 同様にmaxWidthで頭打ちにしておく。
        maxWidth: 320,
        maxHeight: "calc(100vh - 250px)",
        overflowY: "auto",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 4 }}>藤沢市の距離基準を参考にした独自推計</div>
      <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
        鉄道駅600m／バス停300mを参考に、独自の傾斜補正を加えて判定。藤沢市の公式判定そのものではありません。 交通施設は市境・東海道線の外側も含む周辺矩形から抽出。バスは神奈川中央交通のみ、駅は代表点を使用し、運行頻度は考慮していません。
      </div>
      {COVERAGE_RANKS.map((rank) => (
        <div key={rank.legendLabel} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span
            style={{
              display: "inline-block",
              width: 14,
              height: 14,
              background: rank.color.toCssColorString(),
              border: "1px solid rgba(255,255,255,0.6)",
              flexShrink: 0,
            }}
          />
          <span>{rank.legendLabel}</span>
        </div>
      ))}
      <div style={{ marginTop: 4 }}>
        <div style={{ opacity: 0.85, marginBottom: 2 }}>勾配・歩行速度のプロファイル:</div>
        {(Object.keys(WALK_PROFILES) as WalkProfile[]).map((key) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input
              type="radio"
              name="walkProfile"
              checked={walkProfile === key}
              onChange={() => onWalkProfileChange(key)}
            />
            <span>{WALK_PROFILES[key].label}</span>
          </label>
        ))}
      </div>
      <div style={{ marginTop: 4 }}>
        {/* 初見の審査員が「別の判定基準がある」と誤解しないよう、既定で折りたたんでおく
            （detailsではなくdivクリックで開閉するのは、他のLegend要素とスタイルを揃えるため）。
            クリックできることが伝わりにくいという指摘を受け、一般的なアコーディオンの見た目
            （ホバーで背景が変わる・矢印を大きく目立つ色にする・「クリックで詳細」の一言を
            添える）に寄せた。 */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onToggleExperimentalDistanceModel(!showExperimentalDistanceModel)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onToggleExperimentalDistanceModel(!showExperimentalDistanceModel);
          }}
          onMouseEnter={() => setExperimentalHeaderHovered(true)}
          onMouseLeave={() => setExperimentalHeaderHovered(false)}
          style={{
            marginBottom: 2,
            marginLeft: -4,
            marginRight: -4,
            padding: "3px 4px",
            borderRadius: 4,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 5,
            userSelect: "none",
            background: experimentalHeaderHovered ? "rgba(255,255,255,0.14)" : "transparent",
            transition: "background 0.1s ease",
          }}
        >
          <span style={{ fontSize: 13, color: "#6ecbf5", fontWeight: "bold", lineHeight: 1 }}>
            {showExperimentalDistanceModel ? "▼" : "▶"}
          </span>
          <span style={{ opacity: 0.9 }}>距離モデル（実験的機能・クリックで詳細）</span>
        </div>
        {showExperimentalDistanceModel && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="radio"
                name="distanceModel"
                checked={distanceModel === "straight"}
                disabled={loadingNetworkScores}
                onChange={() => onDistanceModelChange("straight")}
              />
              <span>直線距離（既定の判定基準）</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="radio"
                name="distanceModel"
                checked={distanceModel === "network"}
                disabled={loadingNetworkScores}
                onChange={() => onDistanceModelChange("network")}
              />
              <span>道路網距離{loadingNetworkScores ? "（読み込み中…）" : ""}</span>
            </label>
            <div
              style={{
                fontSize: 10.5,
                opacity: 0.75,
                marginTop: 4,
                padding: "4px 6px",
                background: "rgba(255,255,255,0.08)",
                borderRadius: 4,
              }}
            >
              このトグルは藤沢市への検証結果報告のために用意した比較検証機能で、既定の判定基準（直線距離）はこのまま変わりません。「道路網距離」に切り替えると、直線距離では基準を満たす扱いだった建物のうち実際にはどれだけが交通空白地に転じるか（見落としていたニーズ）を確認できます。
            </div>
            <div style={{ marginTop: 6, opacity: distanceModel === "network" ? 1 : 0.5 }}>
              <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>道路網距離モデルの判定基準の緩和倍率: {networkThresholdMultiplier.toFixed(1)}倍</span>
              </label>
              <input
                type="range"
                min={1}
                max={1.5}
                step={0.1}
                value={networkThresholdMultiplier}
                disabled={distanceModel !== "network"}
                onChange={(e) => onNetworkThresholdMultiplierChange(Number(e.target.value))}
                style={{ width: "100%" }}
              />
              <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 2 }}>
                道路網距離は直線距離より系統的に長くなるため、駅600m・バス300mの参考基準にこの倍率をかけて判定を緩和できます（直線距離モデルは300m／600mの閾値で固定）。
              </div>
            </div>
          </>
        )}
      </div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.3)", margin: "8px 0 6px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: BUS_STOP_COLOR.toCssColorString(),
            border: "1px solid rgba(255,255,255,0.6)",
            flexShrink: 0,
          }}
        />
        <span>バス停（神奈川中央交通。色分け計算に使用）</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: BUS_STOP_COLOR_MINOR.toCssColorString(),
            border: "1px solid rgba(255,255,255,0.6)",
            flexShrink: 0,
          }}
        />
        <span>バス停（その他事業者・コミュニティバス。参考表示のみ）</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            background: DEMAND_TRANSIT_COLOR,
            border: "1px solid rgba(255,255,255,0.6)",
            flexShrink: 0,
          }}
        />
        <span>デマンド交通 乗り場候補（本PoCの提案）</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: EXISTING_DEMAND_TRANSIT_COLOR.toCssColorString(),
            border: "1px solid rgba(255,255,255,0.6)",
            flexShrink: 0,
          }}
        />
        <span>乗合タクシー等（藤沢市が既に運行中）</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: HELLO_CYCLING_COLOR,
            border: "1px solid rgba(255,255,255,0.6)",
            flexShrink: 0,
          }}
        />
        <span>ハローサイクリング ステーション</span>
      </div>
      <div style={{ marginTop: 6 }}>
        <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>乗り場候補の数: {clusterCount}箇所</span>
        </label>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={clusterCount}
          onChange={(e) => onClusterCountChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ marginTop: 8, paddingTop: 7, borderTop: "1px solid rgba(255,255,255,0.25)" }}>
        <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>比較分析の実効距離基準: {analysisThresholdMultiplier.toFixed(1)}倍</span>
        </label>
        <input
          type="range"
          min={1}
          max={1.5}
          step={0.1}
          value={analysisThresholdMultiplier}
          onChange={(e) => onAnalysisThresholdMultiplierChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 2 }}>
          比較グラフだけに適用します。バス{Math.round(BUS_COVERAGE_THRESHOLD_METERS * analysisThresholdMultiplier)}m・駅{Math.round(STATION_COVERAGE_THRESHOLD_METERS * analysisThresholdMultiplier)}m相当で、実効距離を評価します。地図の独自推計は変わりません。
        </div>
      </div>
      <div style={{ marginTop: 7, color: isDemandTransitAnalysisRunning ? "#d8b4fe" : "rgba(255,255,255,0.7)", fontSize: 11 }}>
        {isDemandTransitAnalysisRunning ? "比較条件を反映中…" : "この比較用の倍率を変えると、グラフは自動で更新されます。"}
      </div>
      {!isDemandTransitPanelVisible && (
        <button
          type="button"
          onClick={onShowDemandTransitPanel}
          disabled={isDemandTransitAnalysisRunning}
          style={{
            width: "100%", marginTop: 6, padding: "5px 8px", border: "1px solid rgba(216,180,254,0.8)",
            borderRadius: 4, background: isDemandTransitAnalysisRunning ? "rgba(126,34,206,0.25)" : "rgba(126,34,206,0.42)",
            color: "#fff", fontSize: 11,
            cursor: isDemandTransitAnalysisRunning ? "wait" : "pointer",
          }}
        >
          {isDemandTransitAnalysisRunning ? "比較データを計算中…" : "比較グラフを表示"}
        </button>
      )}
      <div style={{ marginTop: 6 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showHelloCycling}
            onChange={(e) => onShowHelloCyclingChange(e.target.checked)}
          />
          <span>ハローサイクリング ステーションを表示</span>
        </label>
      </div>
    </div>
  );
}

// 「なぜ白いままの建物が多いのか」の説明。左上のLegendは既に縦に長いため、
// 空いている右下に別枠で表示する（右上はInfoPopupが使う）。
function UncoloredBuildingsNote() {
  return (
    <div
      style={{
        position: "absolute",
        right: 12,
        bottom: 12,
        zIndex: 10,
        background: "rgba(20, 20, 20, 0.75)",
        color: "#fff",
        padding: "8px 10px",
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1.5,
        fontFamily: "sans-serif",
        maxWidth: 260,
        pointerEvents: "none",
      }}
    >
      白い建物は住宅系以外・用途不明・未評価です。読み込み中、通信失敗、道路網データ未収録の場合も白く表示されます。
    </div>
  );
}



// 道路網距離データ読み込みやプロファイル切り替え時に、画面中央のごく一部にコンパクトに表示するローディングバッジ。
// 全面オーバーレイと異なり、画面全体のマップや建物の色の変化を遮らずに見ることができる。
function CenterLoadingIndicator({
  loadingState,
}: {
  loadingState: { title: string; subtitle?: string } | null;
}) {
  if (!loadingState) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        padding: "12px 20px",
        background: "rgba(15, 23, 42, 0.88)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(56, 189, 248, 0.35)",
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)",
        color: "#fff",
        pointerEvents: "none",
        fontFamily: "sans-serif",
      }}
    >
      <style>{"@keyframes center-loading-spin { to { transform: rotate(360deg); } }"}</style>
      <div
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          border: "3.5px solid rgba(56, 189, 248, 0.25)",
          borderTopColor: "#38bdf8",
          borderRadius: "50%",
          animation: "center-loading-spin 0.85s linear infinite",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ color: "#f8fafc", fontSize: 14, fontWeight: "bold", letterSpacing: "0.02em" }}>
          {loadingState.title}
        </div>
        {loadingState.subtitle && (
          <div style={{ fontSize: 11, color: "#94a3b8" }}>
            {loadingState.subtitle}
          </div>
        )}
      </div>
    </div>
  );
}





// 追加数を増やしたときの改善の伸びを、数値と小さな棒グラフで同時に見せる。
// 「最適数」は費用・用地・運行体制で変わるため断定せず、現在スライダーで選んだ案を
// 地図上の紫ピンと対応させて比較する。
function DemandTransitRecommendationPanel({
  analysis,
  selectedCount,
  isRunning,
  pendingThresholdMultiplier,
  isVisible,
  onClose,
}: {
  analysis: DemandTransitPlanAnalysis | null;
  selectedCount: number;
  isRunning: boolean;
  pendingThresholdMultiplier: number;
  isVisible: boolean;
  onClose: () => void;
}) {
  if (!isVisible) return null;
  if (!analysis && !isRunning) return null;
  if (!analysis) {
    const busThreshold = Math.round(BUS_COVERAGE_THRESHOLD_METERS * pendingThresholdMultiplier);
    const stationThreshold = Math.round(STATION_COVERAGE_THRESHOLD_METERS * pendingThresholdMultiplier);
    return (
      <div
        style={{
          position: "absolute", right: 12, bottom: 82, zIndex: 10,
          width: "min(620px, calc(100vw - 24px))", minHeight: 300,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          boxSizing: "border-box", background: "rgba(20, 20, 20, 0.92)", color: "#fff",
          padding: 30, borderRadius: 6, fontFamily: "sans-serif", pointerEvents: "auto",
        }}
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="アクセス改善比較を閉じる"
          onClick={onClose}
          style={{
            position: "absolute", top: 12, right: 14, border: 0, background: "transparent", color: "#fff",
            fontSize: 28, lineHeight: 1, cursor: "pointer", pointerEvents: "auto",
          }}
        >
          ×
        </button>
        <style>{"@keyframes demand-transit-analysis-spin { to { transform: rotate(360deg); } }"}</style>
        <div style={{ width: 64, height: 64, border: "7px solid rgba(216,180,254,0.25)", borderTopColor: "#d8b4fe", borderRadius: "50%", animation: "demand-transit-analysis-spin 0.9s linear infinite" }} />
        <div style={{ marginTop: 22, color: "#d8b4fe", fontSize: 22, fontWeight: "bold" }}>アクセス改善案を比較中…</div>
        <div style={{ marginTop: 8, fontSize: 15, color: "#e5e7eb" }}>実効距離・基準{pendingThresholdMultiplier.toFixed(1)}倍（バス{busThreshold}m／駅{stationThreshold}m相当）</div>
      </div>
    );
  }
  const selected = analysis.results.find((result) => result.count === selectedCount) ?? analysis.results.at(-1);
  if (!selected) return null;
  const maxReduction = Math.max(
    ...analysis.results.map((result) => result.averageBeforeMeters - result.averageAfterMeters),
    1
  );
  const maxFarthestReduction = Math.max(
    ...analysis.results.map(
      (result) => result.farthestTenPercentBeforeMeters - result.farthestTenPercentAfterMeters
    ),
    1
  );
  const reduction = selected.averageBeforeMeters - selected.averageAfterMeters;
  const comparisonBusThreshold = Math.round(BUS_COVERAGE_THRESHOLD_METERS * analysis.thresholdMultiplier);
  const comparisonStationThreshold = Math.round(STATION_COVERAGE_THRESHOLD_METERS * analysis.thresholdMultiplier);

  return (
    <div
      style={{
        position: "absolute",
        right: 12,
        bottom: 82,
        zIndex: 10,
        // 成果を説明する主パネルなので、従来の幅310pxから約2.5倍に広げる。小さい
        // 画面では画面内に収め、縦方向も必要に応じてパネル内でスクロールさせる。
        width: "min(620px, calc(100vw - 24px))",
        minHeight: "min(700px, calc(100vh - 94px))",
        maxHeight: "calc(100vh - 94px)",
        overflowY: "auto",
        boxSizing: "border-box",
        background: "rgba(20, 20, 20, 0.88)",
        color: "#fff",
        padding: "24px 30px",
        borderRadius: 6,
        fontSize: 16,
        lineHeight: 1.5,
        fontFamily: "sans-serif",
        pointerEvents: "auto",
      }}
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="アクセス改善比較を閉じる"
        onClick={onClose}
        style={{
          position: "absolute", top: 12, right: 14, zIndex: 2, border: 0, background: "transparent", color: "#fff",
          fontSize: 28, lineHeight: 1, cursor: "pointer", pointerEvents: "auto",
        }}
      >
        ×
      </button>
      <div style={{ color: "#d8b4fe", fontSize: 17, fontWeight: "bold" }}>追加乗り場数ごとのアクセス改善比較</div>
      <div
        style={{
          marginTop: 12,
          padding: "12px 14px",
          border: "1px solid rgba(216,180,254,0.75)",
          borderRadius: 6,
          background: "rgba(126,34,206,0.18)",
        }}
      >
        <div style={{ color: "#d8b4fe", fontSize: 14, fontWeight: "bold" }}>現在選択中の案</div>
        <div style={{ marginTop: 2, fontSize: 24, fontWeight: "bold" }}>{selected.count}か所を追加した場合</div>
        <div style={{ marginTop: 4, color: "#ddd", fontSize: 13 }}>
          比較条件：実効距離・基準{analysis.thresholdMultiplier.toFixed(1)}倍（バス{comparisonBusThreshold}m／駅{comparisonStationThreshold}m相当）
        </div>
        <div style={{ marginTop: 3 }}>
          対象建物の平均実効距離: 約{Math.round(selected.averageBeforeMeters)}m → 約
          {Math.round(selected.averageAfterMeters)}m
          <span style={{ color: "#86efac", fontWeight: "bold" }}>（約{Math.round(reduction)}m短縮）</span>
        </div>
        <div>新たに比較基準内のバス圏に入る住宅: {selected.newlyCoveredBuildings.toLocaleString()}棟</div>
        <div style={{ marginTop: 5 }}>
          遠い上位10%の平均実効距離: 約{Math.round(selected.farthestTenPercentBeforeMeters)}m → 約
          {Math.round(selected.farthestTenPercentAfterMeters)}m
          <span style={{ color: "#fcd34d", fontWeight: "bold" }}>
            （約{Math.round(selected.farthestTenPercentBeforeMeters - selected.farthestTenPercentAfterMeters)}m短縮）
          </span>
        </div>
        <div>
          比較基準を1.5倍超過する住宅: {selected.severeGapBeforeBuildings.toLocaleString()}棟 → {selected.severeGapAfterBuildings.toLocaleString()}棟
        </div>
      </div>
      <div style={{ marginTop: 16, borderTop: "2px solid rgba(255,255,255,0.4)", paddingTop: 12 }}>
        <div style={{ color: "#fff", fontSize: 20, fontWeight: "bold" }}>全案の比較（1〜10か所）</div>
        <div style={{ marginTop: 2, marginBottom: 10, fontSize: 13, opacity: 0.8 }}>
          現在選択中の案だけでなく、追加数ごとの短縮幅を並べています。棒が長いほど改善が大きいことを示します。
        </div>
        {analysis.results.map((result) => {
          const resultReduction = result.averageBeforeMeters - result.averageAfterMeters;
          const farthestReduction = result.farthestTenPercentBeforeMeters - result.farthestTenPercentAfterMeters;
          const isSelected = result.count === selectedCount;
          return (
            <div
              key={result.count}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                minHeight: 48,
                marginBottom: 5,
                padding: isSelected ? "3px 5px" : 0,
                borderRadius: 4,
                background: isSelected ? "rgba(192,132,252,0.16)" : "transparent",
              }}
            >
              <span
                style={{
                  width: 66,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  color: isSelected ? "#d8b4fe" : "#ddd",
                  fontWeight: isSelected ? "bold" : "normal",
                }}
              >
                {result.count}か所
              </span>
              <div style={{ display: "grid", gap: 3 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13 }}>
                  <span style={{ width: 50 }}>平均</span>
                  <span style={{ width: 240, height: 12, background: "rgba(255,255,255,0.15)", borderRadius: 6, overflow: "hidden" }}>
                    <span
                      style={{
                        display: "block",
                        width: `${Math.max(2, (resultReduction / maxReduction) * 100)}%`,
                        height: "100%",
                        background: isSelected ? "#c084fc" : "#60a5fa",
                      }}
                    />
                  </span>
                  <span>−{Math.round(resultReduction)}m</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#fcd34d" }}>
                  <span style={{ width: 50 }}>遠い10%</span>
                  <span style={{ width: 240, height: 12, background: "rgba(255,255,255,0.15)", borderRadius: 6, overflow: "hidden" }}>
                    <span
                      style={{
                        display: "block",
                        width: `${Math.max(2, (farthestReduction / maxFarthestReduction) * 100)}%`,
                        height: "100%",
                        background: isSelected ? "#fbbf24" : "#f59e0b",
                      }}
                    />
                  </span>
                  <span>−{Math.round(farthestReduction)}m</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12, color: "#cbd5e1", fontSize: 13 }}>
        各行は、前の案で選んだ地点を残したまま、概算上の短縮量が最も大きい地点を一つずつ追加した案です。
      </div>
      <div style={{ marginTop: 12, fontSize: 13, opacity: 0.7 }}>
        {analysis.scopeLabel}の比較対象 {analysis.targetBuildingCount.toLocaleString()}棟を比較。遠い10%は追加前に最も遠かった建物群を固定して比較しています。{analysis.methodLabel} 用地・運行費用は含みません。
      </div>
      {isRunning && (
        <div
          style={{
            position: "absolute", inset: 0, zIndex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", borderRadius: 6,
            background: "rgba(11, 16, 19, 0.86)", color: "#fff",
          }}
        >
          <style>{"@keyframes demand-transit-analysis-spin { to { transform: rotate(360deg); } }"}</style>
          <div style={{ width: 68, height: 68, border: "8px solid rgba(216,180,254,0.28)", borderTopColor: "#d8b4fe", borderRadius: "50%", animation: "demand-transit-analysis-spin 0.9s linear infinite" }} />
          <div style={{ marginTop: 22, color: "#d8b4fe", fontSize: 22, fontWeight: "bold" }}>条件を反映して比較中…</div>
          <div style={{ marginTop: 8, fontSize: 15, color: "#e5e7eb" }}>実効距離・基準{pendingThresholdMultiplier.toFixed(1)}倍で再計算しています</div>
        </div>
      )}
    </div>
  );
}

export default function PlateauViewer() {
  const popupRequestRef = useRef(0);
  const candidatePopupRef = useRef(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [popup, setPopup] = useState<PopupInfo | null>(null);
  const [demandTransitClusterCount, setDemandTransitClusterCount] = useState(
    DEMAND_TRANSIT_CLUSTER_COUNT_DEFAULT
  );
  const [demandTransitAnalysisThresholdMultiplier, setDemandTransitAnalysisThresholdMultiplier] = useState(
    DEMAND_TRANSIT_ANALYSIS_THRESHOLD_MULTIPLIER_DEFAULT
  );
  // ハローサイクリングのステーションピンの表示/非表示トグル（デフォルトOFF）。初期表示は
  // 本題（交通空白地の色分け・デマンド交通候補地）に絞って見やすくするための既定値で、
  // 必要な場合はユーザーがLegendのチェックボックスから自分でオンにできる。既存のスライダーと
  // 同じ「Legend内のUIでReact stateを変更し、init()内で作られたCesiumエンティティに反映する」
  // 方式を踏襲するが、こちらは再クラスタリングのような重い再計算が不要なため、
  // helloCyclingEntitiesRefに保持した各エンティティのentity.showを直接切り替えるだけで済む。
  const [showHelloCycling, setShowHelloCycling] = useState(false);
  // 勾配感度・歩行速度のプロファイル（「一般」/「高齢者」）。切り替えるとbuildingScoreCacheが
  // 全建物ぶん無効化され、読み込み済みの建物すべてを新しいプロファイルで再計算する（詳細は
  // applyWalkProfileのコメント参照）。
  const [walkProfile, setWalkProfile] = useState<WalkProfile>(WALK_PROFILE_DEFAULT);
  // 【実験的】直線距離モデル/道路網距離モデルの切り替え（詳細はDistanceModelのコメント参照）。
  const [distanceModel, setDistanceModel] = useState<DistanceModel>(DISTANCE_MODEL_DEFAULT);
  // "network"に初めて切り替えたときに大容量JSONを遅延読み込みする。読み込み中はtrueにして
  // Legendのラジオボタンを一時的に操作不能にし、多重フェッチを防ぐ。
  const [loadingNetworkScores, setLoadingNetworkScores] = useState(false);
  // 画面中央のごく一部に表示するコンパクトなローディング状態（道路網距離や高齢者プロファイル切り替え時用）
  const [centerLoading, setCenterLoading] = useState<{ title: string; subtitle?: string } | null>(
    null
  );
  // 【実験的】道路網距離モデルの閾値倍率（詳細はNETWORK_THRESHOLD_MULTIPLIER_DEFAULTのコメント参照）。
  // 直線距離モデルの閾値(300m/600m)は常に固定で、このstateは"network"選択時のみ効く。
  const [networkThresholdMultiplier, setNetworkThresholdMultiplier] = useState(
    NETWORK_THRESHOLD_MULTIPLIER_DEFAULT
  );
  // 【実験的】距離モデルのUIブロック（ラジオボタン・説明文・緩和倍率スライダー）の折りたたみ
  // 開閉状態。初見の審査員が「別の判定基準がある」と誤解しないよう、既定で閉じておく
  // （詳細な経緯はセクション見出しの説明文参照）。
  const [showExperimentalDistanceModel, setShowExperimentalDistanceModel] = useState(false);
  // 「追加数と改善効果を比較」ボタンの結果。計算時点で読み込み済みの建物を対象にするため、
  // カメラ移動で後から建物が増えても、表示済みの比較結果はその時点のスナップショットとして残す。
  const [demandTransitPlanAnalysis, setDemandTransitPlanAnalysis] = useState<DemandTransitPlanAnalysis | null>(null);
  const [isDemandTransitAnalysisRunning, setIsDemandTransitAnalysisRunning] = useState(false);
  // 初見では地図の把握を優先し、比較結果は左上のボタンから任意で開く。
  const [isDemandTransitPanelVisible, setIsDemandTransitPanelVisible] = useState(false);
  // Cesiumのイベントハンドラ（init()内のクロージャ）はマウント時に1度だけ作られ、Reactの
  // 再レンダリングでは作り直されないため、スライダーの最新値をそのクロージャから読めるように
  // refで橋渡しする（値が変わるたびにrefだけ更新し、Viewer自体は再構築しない）。
  const demandTransitClusterCountRef = useRef(demandTransitClusterCount);
  const demandTransitAnalysisThresholdMultiplierRef = useRef(demandTransitAnalysisThresholdMultiplier);
  const walkProfileRef = useRef(walkProfile);
  const distanceModelRef = useRef(distanceModel);
  const networkThresholdMultiplierRef = useRef(networkThresholdMultiplier);
  // ハローサイクリングのピンをinit()内で非同期生成する際、生成時点のトグル状態を
  // 直接参照するためのref（他のトグルと同じ理由。init()のuseEffectは依存配列が空なので、
  // stateを直接参照するとexhaustive-depsの警告が出るうえ値も更新されない）。
  const showHelloCyclingRef = useRef(showHelloCycling);
  useEffect(() => {
    demandTransitClusterCountRef.current = demandTransitClusterCount;
    demandTransitAnalysisThresholdMultiplierRef.current = demandTransitAnalysisThresholdMultiplier;
    walkProfileRef.current = walkProfile;
    distanceModelRef.current = distanceModel;
    networkThresholdMultiplierRef.current = networkThresholdMultiplier;
    showHelloCyclingRef.current = showHelloCycling;
  }, [
    demandTransitClusterCount,
    demandTransitAnalysisThresholdMultiplier,
    walkProfile,
    distanceModel,
    networkThresholdMultiplier,
    showHelloCycling,
  ]);
  // init()内で定義されるscheduleDemandTransitRecomputeをスライダーのonChangeから呼べるように
  // するための橋渡し。Viewerがまだ初期化中の場合はnullのままで、呼び出し側でガードする。
  const scheduleDemandTransitRecomputeRef = useRef<(() => void) | null>(null);
  const scheduleDemandTransitAnalysisRef = useRef<((delayMs?: number) => void) | null>(null);
  // プロファイル切り替えのonChangeから呼べるようにするための橋渡し。walkProfileRef.currentを
  // 同期的に更新してからbuildingScoreCacheを無効化・再計算するため、上のuseEffect経由の
  // 非同期な同期だと間に合わない（イベントハンドラ内でsetWalkProfileした直後にこの関数を
  // 呼ぶと、re-render前なのでuseEffectがまだ走っていない）。そのためinit()側の関数自身が
  // walkProfileRef.currentを直接書き換える。
  const applyWalkProfileRef = useRef<((profile: WalkProfile) => void) | null>(null);
  // 【実験的】距離モデル切り替えのonChangeから呼べるようにするための橋渡し（applyWalkProfileRefと同じ理由）。
  const applyDistanceModelRef = useRef<((model: DistanceModel) => void) | null>(null);
  // 【実験的】道路網距離モデルの閾値倍率スライダーのonChangeから呼べるようにするための橋渡し
  // （applyWalkProfileRefと同じ理由。同期的にrefを書き換えてからキャッシュを無効化する）。
  const applyNetworkThresholdMultiplierRef = useRef<((multiplier: number) => void) | null>(null);
  // ハローサイクリングのピンとして作成した全エンティティを保持し、トグル操作のたびに
  // entity.showを一括で切り替えられるようにする（データの再取得・再作成はしない）。
  const helloCyclingEntitiesRef = useRef<Cesium.Entity[]>([]);
  useEffect(() => {
    for (const entity of helloCyclingEntitiesRef.current) {
      entity.show = showHelloCycling;
    }
  }, [showHelloCycling]);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    let cancelled = false;
    let disposeRuntime = () => {};

    async function init() {
      let terrainProvider: Cesium.TerrainProvider;
      try {
        terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL);
      } catch (err) {
        console.error("PLATEAU-Terrainの読み込みに失敗しました。平坦な地形で継続します。", err);
        terrainProvider = new Cesium.EllipsoidTerrainProvider();
      }
      if (cancelled || !containerRef.current) return;

      const viewer = new Cesium.Viewer(containerRef.current, {
        terrainProvider,
        // Cesium ionのデフォルト背景画像を使わず、PLATEAU-Ortho（ion不要）を使う
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(
          Promise.resolve(
            new Cesium.UrlTemplateImageryProvider({
              url: ORTHO_URL,
              credit: "Project PLATEAU (国土交通省)",
              maximumLevel: 19,
            })
          ),
          {}
        ),
        // 開発中に不要なUIを削って画面を広く使う。必要に応じて有効化する。
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        animation: false,
        timeline: false,
        // 独自のバス停ポップアップUIと、Cesium標準のinfoBox/selectionIndicatorが
        // 競合しないよう最初から無効化している（plateau-pocで発生した問題の再発防止）。
        infoBox: false,
        selectionIndicator: false,
      });
      viewerRef.current = viewer;

      let tileset: Cesium.Cesium3DTileset | undefined;
      try {
        tileset = await Cesium.Cesium3DTileset.fromUrl(BUILDING_TILESET_URL);
        if (cancelled) return;
        // デフォルトのcolorBlendMode(HIGHLIGHT)はfeature.colorを建物の元のマテリアル色と
        // 乗算するため、元の色が純白でない場合に色分けが意図した色より薄暗く・分かりにくく
        // なることがある。REPLACEにして、スコアに応じた色をそのまま表示させる。
        tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE;
        viewer.scene.primitives.add(tileset);
      } catch (err) {
        console.error("PLATEAU 建物3D Tilesの読み込みに失敗しました", err);
      }

      // PLATEAU-Orthoは藤沢市北部エリアで一部タイルが404になり抜けがある
      // （江の島周辺を扱うplateau-pocでは発生しなかった。おそらくオルソ画像の
      // モザイク範囲がエリアによって粗密差がある）。Cesiumのデフォルト地表色（青、
      // 一見「海」に見えて紛らわしい）ではなく中立なグレーにして、抜けを「データなし」と
      // 分かるようにしておく。
      viewer.scene.globe.baseColor = Cesium.Color.DARKSLATEGRAY;

      // バス停をピンで表示する。ラベルは付けず、クリックで名称をポップアップ表示する
      // （337件と数が多く、常時ラベル表示すると密集地でズームアウト時に重なりすぎるため）。
      // busStopList は自動フィット用に全件保持し、majorOperatorStopList は実効距離の
      // 計算（最寄りバス停検索）専用に主要事業者のみへ絞り込んだもの。
      const busStopPositions: Cesium.Cartesian3[] = [];
      let busStopList: BusStop[] = [];
      let majorOperatorStopList: BusStop[] = [];
      try {
        const res = await fetch(BUS_STOPS_JSON_URL);
        const data: { busStops: BusStop[] } = await res.json();
        if (cancelled) return;
        busStopList = data.busStops;
        majorOperatorStopList = busStopList.filter(isMajorOperatorStop);
        for (const stop of busStopList) {
          const position = Cesium.Cartesian3.fromDegrees(stop.lng, stop.lat);
          busStopPositions.push(position);
          const isMajor = isMajorOperatorStop(stop);
          viewer.entities.add({
            name: stop.name,
            position,
            properties: { isBusStop: true, operator: stop.operator, routes: stop.routes, isMajorOperator: isMajor },
            point: {
              pixelSize: isMajor ? BUS_STOP_PIXEL_SIZE : BUS_STOP_PIXEL_SIZE_MINOR,
              color: isMajor ? BUS_STOP_COLOR : BUS_STOP_COLOR_MINOR,
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
        }
      } catch (err) {
        console.error("バス停データの読み込みに失敗しました", err);
      }

      // 建物の北部判定（JR東海道本線より北側か）に使う簡易ポリラインを読み込む。
      let tokaidoLinePoints: [number, number][] = [];
      try {
        const res = await fetch(TOKAIDO_LINE_JSON_URL);
        const data: { points: [number, number][] } = await res.json();
        if (cancelled) return;
        tokaidoLinePoints = data.points;
      } catch (err) {
        console.warn(
          "東海道線データの読み込みに失敗しました。建物のアクセシビリティ色分けはスキップされます。",
          err
        );
      }

      // 市の距離閾値を参考にした推計に使う周辺交通施設データを読み込む。
      let trainStationList: TrainStation[] = [];
      try {
        const res = await fetch("/data/analysis-facilities.json");
        if (!res.ok) throw new Error("交通施設データの取得に失敗しました");
        const data: { stations: TrainStation[]; busStops: BusStop[] } = await res.json();
        majorOperatorStopList = data.busStops.filter(isMajorOperatorStop);
        if (cancelled) return;
        trainStationList = data.stations;
      } catch (err) {
        console.warn(
          "鉄道駅データの読み込みに失敗しました。建物のアクセシビリティ色分けはスキップされます。",
          err
        );
      }

      // 駅・地区名をテキストラベルとして常時表示する。土地勘のない判定員・自治体職員でも
      // 位置関係を把握できるようにするための、あくまで補助的な表示（クリック不要、装飾のみ）。
      // isDemandTransitCandidate等のpropertiesを付けていないため、クリックハンドラの分岐には
      // 一切引っかからず、素通りしてsetPopup(null)になるだけ（既存の建物・バス停クリックと競合しない）。
      try {
        const res = await fetch(PLACE_LABELS_JSON_URL);
        const data: { places: PlaceLabel[] } = await res.json();
        if (cancelled) return;
        for (const place of data.places) {
          viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(place.lng, place.lat),
            label: {
              text: place.name,
              font: "bold 16px sans-serif",
              // バス停ピンの半透明色と同じ理由（背景の建物・地表色と合成されて薄く見えてしまう）で、
              // 塗り・縁取りとも不透明にしている。
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 4,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              // デマンド交通候補ピンと同じ理由（密集市街地で3D Tiles建物の陰に隠れるのを防ぐ）で
              // 深度テストを無効化し、常に手前に表示する。
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }
      } catch (err) {
        console.warn("地名ラベルデータの読み込みに失敗しました。ラベル表示なしで継続します。", err);
      }

      // 藤沢市が既に運行している乗合タクシー・オンデマンドバスの拠点を、青い円ピンでオーバーレイ
      // 表示する。デマンド交通候補（紫の四角、このPoCの提案）と見た目で明確に区別することで、
      // 「市の既存の取り組みを無視して候補を出しているのではない」ことを示す（詳細は上記
      // EXISTING_DEMAND_TRANSIT_JSON_URLのコメント参照）。
      // 【対応済みの不具合】当初は概算の運行エリアを半透明の円（ellipse、GroundPrimitiveとして
      // 地形に貼り付く）でも表示していたが、viewer.scene.pick()はクリック位置で最前面の
      // オブジェクトを1つだけ返す仕様のため、この円の範囲内（半径数百m）にある建物をクリックしても
      // 3D Tilesの建物フィーチャーではなく必ずこの円のエンティティが拾われてしまい、円の下にある
      // 建物の情報を一切表示できなくなっていた。円は情報量としては副次的（ピンの位置だけで
      // 拠点は伝わる）なので、円を削除しピンのみの表示に変更して解消した。
      try {
        const res = await fetch(EXISTING_DEMAND_TRANSIT_JSON_URL);
        const data: { services: ExistingDemandTransitService[] } = await res.json();
        if (cancelled) return;
        const existingDemandTransitIconUrl = createCircleIconDataUrl(
          EXISTING_DEMAND_TRANSIT_COLOR.toCssColorString()
        );
        for (const service of data.services) {
          // サービス単位ではなく、実際の停留所（stops）単位でピンを1つずつ配置する
          // （詳細は上記コメント参照。天神町10件・のりあい善行17件、いずれも実在の停留所）。
          for (const stop of service.stops) {
            viewer.entities.add({
              name: `${service.name}（${stop.name}）`,
              position: Cesium.Cartesian3.fromDegrees(stop.lng, stop.lat),
              properties: { isExistingDemandTransit: true, service, stopName: stop.name },
              billboard: {
                image: existingDemandTransitIconUrl,
                // 【対応済みの経緯】バス停ピン（pixelSize=BUS_STOP_PIXEL_SIZE=10）に合わせて
                // 一度10x10に縮小したが、「見つけづらくなった」というフィードバックを受けて
                // 元の20x20に戻した。他の丸ピンより一回り大きいのは、この地図上では
                // 意図的な差別化（既存デマンド交通は目立たせたい）として許容する。
                width: 20,
                height: 20,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
          }
        }
      } catch (err) {
        console.warn("既存デマンド交通データの読み込みに失敗しました。オーバーレイ表示なしで継続します。", err);
      }

      // ハローサイクリングのステーションを黄色い自転車ピンで表示する（表示のみ、色分けロジックには
      // 未組み込み）。/api/hellocycling-stations はサーバー側でODPT_CONSUMER_KEYが未設定の場合や
      // ODPT側のエラー時に500/502を返すが、いずれもこのアプリの他の機能には影響しないため、
      // 失敗時はconsole.warnのみでピン無しのまま継続する。
      try {
        const res = await fetch(HELLO_CYCLING_STATIONS_API_URL);
        if (!res.ok) throw new Error(`hellocycling-stations API returned ${res.status}`);
        const data: { stations: HelloCyclingStation[] } = await res.json();
        if (cancelled) return;
        const bicycleIconUrl = createBicycleIconDataUrl(HELLO_CYCLING_COLOR);
        for (const station of data.stations) {
          const entity = viewer.entities.add({
            name: station.name,
            position: Cesium.Cartesian3.fromDegrees(station.lng, station.lat),
            properties: { isHelloCyclingStation: true, capacity: station.capacity },
            // 初期表示（既定OFF）とここでの生成が非同期に完了するタイミングがズレるため、
            // Cesiumのentity.showの既定値（true）に任せず、現在のトグル状態を明示的に渡す。
            // 切り替えのたびの反映は下のuseEffect（helloCyclingEntitiesRef経由）が担う。
            show: showHelloCyclingRef.current,
            billboard: {
              image: bicycleIconUrl,
              width: 22,
              height: 22,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
          helloCyclingEntitiesRef.current.push(entity);
        }
      } catch (err) {
        console.warn("ハローサイクリングのステーションデータの読み込みに失敗しました。ピン表示なしで継続します。", err);
      }

      // 住宅系建物ごとに「最寄りバス停・最寄り駅までの傾斜込み実効距離」を計算し、市の距離基準を参考にした
      // 距離閾値を参考にした独自推計（駅600m or バス300mのOR）で3D Tilesのフィーチャーを直接色分けする。
      // buildingScoreCache は建物ID(_x,_yから作る代替IDを含む)をキーに永続化し、タイルが
      // アンロード→再ロードされて新しいCesium3DTileFeatureインスタンスになった場合でも
      // 地形サンプリングをやり直さずに再着色できるようにする。featureScoreMapは
      // クリック時に「今画面にある生きたfeatureオブジェクト」からスコア情報を引くためのWeakMap。
      type CachedScore = { color: Cesium.Color; info: BuildingScoreInfo };
      const buildingScoreCache = new Map<string, CachedScore>();
      let featureScoreMap = new WeakMap<Cesium.Cesium3DTileFeature, BuildingScoreInfo>();
      // 【実験的】道路網距離モデル用の事前計算データ（scripts/road-network/03_compute_scores.py
      // の出力）。"network"に初めて切り替えたときにapplyDistanceModelが遅延フェッチしてここへ
      // 格納する。buildingIdをキーに直接引けるので、該当する建物は地形サンプリング不要で
      // 即座に色を決められる。
      let networkScoreMap: Map<string, BuildingNetworkScoreRow> | null = null;
      // 成功した世代だけ処理済みとし、失敗はバックオフ後にtileVisibleから再試行する。
      const tileWork = new TileWorkGate<Cesium.Cesium3DTile>();

      // デマンド交通乗り場候補（k-meansのクラスタ重心）を紫の四角ピンで表示する。
      // 建物のスコア計算が進むたびに（buildingScoreCacheが更新されるたびに）再クラスタリングする
      // 必要があるため、候補ピンの実体（Entity）とクラスタ内訳（members）を紐付けて保持しておく
      // （クリック時に「対象建物数」「現状の平均実効距離」を即座に表示するため）。
      // busEffectiveDistanceMetersを表示用に保持している（対象建物のほとんどはバス距離が
      // カバー率のボトルネックになるため、代表的な指標として引き続きバス実効距離を見せる。
      // 抽出基準そのものはcoverageRatioの閾値なので、駅が近くバスが遠い建物も理論上は含まれ得る）。
      type DemandTransitCandidate = {
        entity: Cesium.Entity;
        centroidLat: number;
        centroidLng: number;
        members: DemandTransitMember[];
        estimatedAfter?: number;
      };
      let demandTransitCandidates: DemandTransitCandidate[] = [];
      // 比較ボタンを押した後は、表示範囲に依存するbuildingScoreCacheではなく藤沢市北部全域の
      // 建物をここに保持し、グラフの各案と同じ母集団から紫の候補ピンを描く。
      let demandTransitAnalysisMembers: DemandTransitMember[] | null = null;
      let demandTransitAnalysisSites: DemandTransitPlanSite[] | null = null;
      let demandTransitRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
      // クリックのたびにインクリメントし、非同期の「新設した場合の推定実効距離」計算が
      // 完了した時点で最新のクリックと一致するかを確認する（古いリクエストの結果で
      // ポップアップを上書きしないようにするため）。

      const demandTransitIconUrl = createSquareIconDataUrl(DEMAND_TRANSIT_COLOR);

      function recomputeDemandTransitCandidates() {
        if (cancelled) return;
        ++popupRequestRef.current;
        if (candidatePopupRef.current) { setPopup(null); candidatePopupRef.current = false; }
        const gapBuildings: DemandTransitMember[] = demandTransitAnalysisMembers
          ? demandTransitAnalysisMembers
          : [];
        if (!demandTransitAnalysisMembers) {
          for (const { info } of buildingScoreCache.values()) {
            if (info.coverageRatio > DEMAND_TRANSIT_GAP_RATIO_THRESHOLD) {
              gapBuildings.push({
                lat: info.lat,
                lng: info.lng,
                busStraightDistanceMeters: info.busStraightDistanceMeters,
                busEffectiveDistanceMeters: info.busEffectiveDistanceMeters,
                stationEffectiveDistanceMeters: info.stationEffectiveDistanceMeters,
                coverageRatio: info.coverageRatio,
              });
            }
          }
        }

        // 既存の候補ピンをいったん全部消してから作り直す（差分更新は複雑になるため単純化）。
        for (const candidate of demandTransitCandidates) {
          viewer.entities.remove(candidate.entity);
        }
        demandTransitCandidates = [];

        if (gapBuildings.length < DEMAND_TRANSIT_MIN_BUILDINGS) return;

        const refLat = gapBuildings.reduce((sum, b) => sum + b.lat, 0) / gapBuildings.length;
        const refLng = gapBuildings.reduce((sum, b) => sum + b.lng, 0) / gapBuildings.length;
        const projected = gapBuildings.map((b) => projectToLocalMeters(b.lat, b.lng, refLat, refLng));
        let clusters: { centroid: [number, number]; indices: number[] }[];
        if (demandTransitAnalysisSites) {
          // 全域比較で選んだ地点をそのまま使い、各建物を最も近い選択済み地点へ割り当てる。
          // これにより、地図の紫ピンとグラフの同じ行が完全に対応する。
          const selectedSites = demandTransitAnalysisSites.slice(0, demandTransitClusterCountRef.current);
          const sitePoints = selectedSites.map((site) => projectToLocalMeters(site.lat, site.lng, refLat, refLng));
          const indices = sitePoints.map(() => [] as number[]);
          projected.forEach((point, buildingIndex) => {
            let closestSite = 0;
            let closestDistance = Infinity;
            sitePoints.forEach((sitePoint, siteIndex) => {
              const dx = point[0] - sitePoint[0];
              const dy = point[1] - sitePoint[1];
              const distance = dx * dx + dy * dy;
              if (distance < closestDistance) {
                closestDistance = distance;
                closestSite = siteIndex;
              }
            });
            if (sitePoints.length > 0) indices[closestSite].push(buildingIndex);
          });
          clusters = sitePoints.map((centroid, index) => ({ centroid, indices: indices[index] }));
        } else {
          clusters = kMeans(projected, demandTransitClusterCountRef.current);
        }

        for (const [clusterIndex, cluster] of clusters.entries()) {
          const [centroidLat, centroidLng] = unprojectFromLocalMeters(
            cluster.centroid[0],
            cluster.centroid[1],
            refLat,
            refLng
          );
          const members = cluster.indices.map((i) => gapBuildings[i]);
          if (!members.length) continue;
          const entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(centroidLng, centroidLat),
            properties: { isDemandTransitCandidate: true },
            billboard: {
              image: demandTransitIconUrl,
              width: 22,
              height: 22,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              // CLAMP_TO_GROUNDは地形面には正しく貼り付くが、3D Tiles建物が候補地点の
              // 真上にあるとその陰に隠れてしまうことがあるため、深度テストを無効化して
              // 常に手前に表示されるようにする（バス停ピンは建物の少ない場所に置かれがちで
              // 目立たなかったが、この候補ピンは密集市街地の中心に来ることが多いため必要）。
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
          const distances = demandTransitAnalysisSites?.[clusterIndex]?.distances;
          const estimatedAfter = distances && members.length ? cluster.indices.reduce((sum,i) =>
            sum + Math.min(gapBuildings[i].busEffectiveDistanceMeters, distances[i]),0)/members.length : undefined;
          demandTransitCandidates.push({ entity, centroidLat, centroidLng, members, estimatedAfter });
        }
      }

      function scheduleDemandTransitRecompute() {
        if (demandTransitRecomputeTimer) clearTimeout(demandTransitRecomputeTimer);
        demandTransitRecomputeTimer = setTimeout(() => {
          demandTransitRecomputeTimer = null;
          recomputeDemandTransitCandidates();
        }, DEMAND_TRANSIT_RECOMPUTE_DEBOUNCE_MS);
      }
      // スライダー操作（Reactのイベントハンドラ、このクロージャの外側）から再計算を
      // トリガーできるようにrefへ登録しておく。
      scheduleDemandTransitRecomputeRef.current = scheduleDemandTransitRecompute;
      // 比較用の全域データを必要な時だけ読む。78,542棟ぶんの事前計算ファイルは42MBあるため、
      // 通常の地図表示・建物色分けだけを見る利用者にはダウンロードさせない。
      let networkScoresPromise: Promise<Map<string, BuildingNetworkScoreRow> | null> | null = null;
      async function ensureNetworkScoreMap(): Promise<Map<string, BuildingNetworkScoreRow> | null> {
        if (networkScoreMap) return networkScoreMap;
        if (networkScoresPromise) return networkScoresPromise;
        setLoadingNetworkScores(true);
        networkScoresPromise = (async () => {
          try {
            const res = await fetch(BUILDING_NETWORK_SCORES_JSON_URL);
            if (!res.ok) throw new Error(`network scores: ${res.status}`);
            const rows: BuildingNetworkScoreRow[] = await res.json();
            if (cancelled) return null;
            networkScoreMap = new Map(rows.map(row => [row.buildingId, row]));
            return networkScoreMap;
          } catch (error) {
            console.warn('道路網データの取得に失敗しました', error);
            return null;
          } finally {
            networkScoresPromise = null;
            if (!cancelled) setLoadingNetworkScores(false);
          }
        })();
        return networkScoresPromise;
      }

      // 全域比較はWorkerで実行。道路網モデルは選択候補を同じ道路網で再評価する。
      let demandTransitAnalysisTimer: number | null = null;
      let demandTransitAnalysisRunId = 0;
      let analysisWorker: Worker | null = null;
      let analysisRequested = false;
      function runDemandTransitAnalysis(runId: number) {
        if (cancelled || runId !== demandTransitAnalysisRunId) return;
        analysisWorker?.terminate();
        setAnalysisError(null);
        const thresholdMultiplier = demandTransitAnalysisThresholdMultiplierRef.current;
        const worker = new Worker(new URL('./workers/transit-analysis.worker.ts', import.meta.url));
        analysisWorker = worker;
        const fail = (message: string) => {
          if (cancelled || runId !== demandTransitAnalysisRunId) return;
          worker.terminate();
          analysisWorker = null;
          setAnalysisError(message);
          setIsDemandTransitAnalysisRunning(false);
          setDemandTransitPlanAnalysis(null);
          demandTransitAnalysisMembers = null;
          demandTransitAnalysisSites = null;
          scheduleDemandTransitRecompute();
        };
        worker.onerror = () => fail('比較処理に失敗しました。「比較グラフを表示」から再試行できます。');
        worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
          if (cancelled || runId !== demandTransitAnalysisRunId) return;
          const data = event.data;
          if ('error' in data) { fail(data.error); return; }
          worker.terminate();
          analysisWorker = null;
          demandTransitAnalysisMembers = data.members;
          demandTransitAnalysisSites = data.sites;
          if (!data.results.length) {
            setAnalysisError('この条件では比較対象の交通空白地がありません。');
            setDemandTransitPlanAnalysis(null);
          } else {
            setDemandTransitPlanAnalysis({targetBuildingCount:data.members.length,
              scopeLabel:`藤沢市北部全域（住宅系建物${data.total.toLocaleString()}棟）`,
              methodLabel:data.methodLabel, thresholdMultiplier, results:data.results});
          }
          recomputeDemandTransitCandidates();
          setIsDemandTransitAnalysisRunning(false);
        };
        worker.postMessage({profile:walkProfileRef.current,model:distanceModelRef.current,
          thresholdMultiplier,stops:majorOperatorStopList,stations:trainStationList});
      }
      function scheduleDemandTransitAnalysis(delayMs = 450) {
        analysisRequested = true;
        analysisWorker?.terminate();
        analysisWorker = null;
        ++popupRequestRef.current;
        setPopup(null);
        demandTransitAnalysisRunId++;
        const scheduledRunId = demandTransitAnalysisRunId;
        if (demandTransitAnalysisTimer) window.clearTimeout(demandTransitAnalysisTimer);
        setIsDemandTransitAnalysisRunning(true);
        demandTransitAnalysisTimer = window.setTimeout(() => {
          demandTransitAnalysisTimer = null;
          void runDemandTransitAnalysis(scheduledRunId);
        }, delayMs);
      }
      scheduleDemandTransitAnalysisRef.current = scheduleDemandTransitAnalysis;
      // 起動時は全域データの読み込みと数千万回の計算を走らせず、ユーザーが「比較グラフを表示」を
      // 押したときに初めて遅延実行する（起動負荷と地名ラベルの脱落を防止するため）。

      async function processTile(tile: Cesium.Cesium3DTile, generation: number): Promise<boolean> {
        if (tokaidoLinePoints.length === 0 || majorOperatorStopList.length === 0 || trainStationList.length === 0) return false;
        if (cancelled) return false;
        if (distanceModelRef.current === 'network' && !networkScoreMap) return false;
        const content = tile.content;
        const isCurrent = () => !cancelled && generation === tileWork.generation && tile.content === content;
        if (!content || content.featuresLength === 0) return true;

        type Candidate = {
          feature: Cesium.Cesium3DTileFeature;
          buildingId: string;
          lng: number;
          lat: number;
          usage: string;
          totalFloorArea: number | null;
        };
        const candidates: Candidate[] = [];

        for (let i = 0; i < content.featuresLength; i++) {
          const feature = content.getFeature(i);
          const usage = feature.getProperty("bldg:usage") as string | undefined;
          if (!usage || !usage.includes(RESIDENTIAL_USAGE_SUBSTRING)) continue;
          const lng = feature.getProperty("_x") as number | undefined;
          const lat = feature.getProperty("_y") as number | undefined;
          if (typeof lng !== "number" || typeof lat !== "number") continue;
          if (!isNorthOfTokaidoLine(tokaidoLinePoints, lng, lat)) continue;

          const buildingId =
            (feature.getProperty("uro:BuildingIDAttribute_uro:buildingID") as string | undefined) ??
            `${lng},${lat}`;

          const cached = buildingScoreCache.get(buildingId);
          if (cached) {
            feature.color = cached.color;
            featureScoreMap.set(feature, cached.info);
            continue;
          }
          feature.color = Cesium.Color.WHITE;
          featureScoreMap.delete(feature);
          if (buildingScoreCache.size + candidates.length >= MAX_SCORED_BUILDINGS) continue;

          const totalFloorArea = feature.getProperty(
            "uro:BuildingDetailAttribute_uro:totalFloorArea"
          ) as number | null | undefined;
          candidates.push({ feature, buildingId, lng, lat, usage, totalFloorArea: totalFloorArea ?? null });
        }

        if (candidates.length === 0) return true;

        const profile = WALK_PROFILES[walkProfileRef.current];

        // buildingScoreCache/featureScoreMapへの登録・色付け・カウンタ更新を1箇所にまとめた
        // ヘルパー。直線距離モデル（ライブ計算）・道路網距離モデル（事前計算データ）の
        // どちらの経路からも同じ形で呼べるようにしている。
        function recordScore(feature: Cesium.Cesium3DTileFeature, buildingId: string, info: BuildingScoreInfo) {
          if (!isCurrent()) return;
          const color = colorForCoverageRatio(info.coverageRatio);
          feature.color = color;
          buildingScoreCache.set(buildingId, { color, info });
          featureScoreMap.set(feature, info);
        }

        // 【実験的】道路網距離モデルが選択されていて事前計算データが読み込み済みなら、該当する
        // 建物はそちらの数値をそのまま使う（地形サンプリング不要）。事前計算データに無い建物
        // （オフライン抽出との差分等）は未評価のまま残し、距離モデルを混在させない。
        let liveCandidates = candidates;
        if (distanceModelRef.current === "network" && networkScoreMap) {
          liveCandidates = [];
          for (const c of candidates) {
            const row = networkScoreMap.get(c.buildingId);
            if (!row) {
              continue;
            }
            const busEff =
              walkProfileRef.current === "general" ? row.busEffectiveDistanceM_general : row.busEffectiveDistanceM_elderly;
            const stationEff =
              walkProfileRef.current === "general"
                ? row.stationEffectiveDistanceM_general
                : row.stationEffectiveDistanceM_elderly;
            // 事前計算済みのrow.coverageRatio_*（固定300m/600m基準で焼き込み済み）はそのまま
            // 使わず、閾値倍率スライダーの現在値を反映してその場で計算し直す（道路網距離は
            // 系統的に長くなるため、倍率>1で判定を緩められるようにする。上のコメント参照）。
            const multiplier = networkThresholdMultiplierRef.current;
            const coverageRatio = Math.min(
              busEff / (BUS_COVERAGE_THRESHOLD_METERS * multiplier),
              stationEff / (STATION_COVERAGE_THRESHOLD_METERS * multiplier)
            );
            const info: BuildingScoreInfo = {
              usage: c.usage,
              lat: c.lat,
              lng: c.lng,
              nearestStopName: row[`nearestStopName_${walkProfileRef.current}`],
              // 道路網距離モデルには「直線距離」の概念が無いため、勾配加味前の道路網距離を代用する
              // （現状のUIはこの値を表示していないため実用上の影響はない）。
              busStraightDistanceMeters: walkProfileRef.current === "general" ? row.busNetworkDistanceM : row.busNetworkDistanceM_elderly,
              busEffectiveDistanceMeters: busEff,
              busWalkMinutes: busEff / profile.walkSpeedMPerMin,
              nearestStationName: row[`nearestStationName_${walkProfileRef.current}`],
              stationStraightDistanceMeters: walkProfileRef.current === "general" ? row.stationNetworkDistanceM : row.stationNetworkDistanceM_elderly,
              stationEffectiveDistanceMeters: stationEff,
              stationWalkMinutes: stationEff / profile.walkSpeedMPerMin,
              coverageRatio,
              isCovered: coverageRatio <= 1,
              totalFloorArea: c.totalFloorArea,
              walkProfileLabel: `${profile.label}（道路網距離モデル・実験的）`,
            };
            recordScore(c.feature, c.buildingId, info);
          }
        }

        if (liveCandidates.length === 0) {
          scheduleDemandTransitRecompute();
          return true;
        }

        // 各建物の最寄りバス停・最寄り駅を探す。バス停は主要事業者のみを対象にする
        // （理由は上のMAJOR_OPERATOR_KEYWORDSのコメント参照）。駅は5件のみなのでどちらも
        // 総当たりで十分速い。
        const withNearest = liveCandidates.map((c) => {
          let bestStop: BusStop | null = null;
          let bestStopDist = Infinity;
          for (const stop of majorOperatorStopList) {
            const d = haversineMeters(c.lat, c.lng, stop.lat, stop.lng);
            if (d < bestStopDist) {
              bestStopDist = d;
              bestStop = stop;
            }
          }
          let bestStation: TrainStation | null = null;
          let bestStationDist = Infinity;
          for (const station of trainStationList) {
            const d = haversineMeters(c.lat, c.lng, station.lat, station.lng);
            if (d < bestStationDist) {
              bestStationDist = d;
              bestStation = station;
            }
          }
          return { ...c, nearestStop: bestStop as BusStop, nearestStation: bestStation as TrainStation };
        });

        // バス用ペア・駅用ペアを1つの配列に連結し、地形サンプリングを1回のバッチ呼び出しに
        // まとめる（既存の「タイル単位でバッチ化する」方針を維持。前半がバス、後半が駅の結果）。
        // 勾配感度（プロファイル）はこの時点のwalkProfileRef.currentを使う。プロファイル切替時は
        // applyWalkProfileがbuildingScoreCacheを空にしてから全読み込み済みタイルでprocessTileを
        // 呼び直すため、ここで最新の値を読めば自動的に新プロファイルで再計算される（profileは
        // このprocessTile関数の先頭で既に取得済み）。
        let results: EffectiveDistanceResult[];
        try {
          const busPairs = withNearest.map((c) => ({
            originLat: c.lat,
            originLng: c.lng,
            destLat: c.nearestStop.lat,
            destLng: c.nearestStop.lng,
          }));
          const stationPairs = withNearest.map((c) => ({
            originLat: c.lat,
            originLng: c.lng,
            destLat: c.nearestStation.lat,
            destLng: c.nearestStation.lng,
          }));
          results = await computeEffectiveDistances(
            terrainProvider,
            [...busPairs, ...stationPairs],
            profile.slopePenaltyFactor
          );
        } catch (err) {
          console.warn(
            "傾斜計算用の地形サンプリングに失敗しました。このタイルの建物群はスコア計算をスキップします。",
            err
          );
          return false;
        }
        if (!isCurrent()) return false;

        const n = withNearest.length;
        withNearest.forEach((c, idx) => {
          const { straightDistanceMeters: busStraightDistanceMeters, effectiveDistanceMeters: busEffectiveDistanceMeters } =
            results[idx];
          const {
            straightDistanceMeters: stationStraightDistanceMeters,
            effectiveDistanceMeters: stationEffectiveDistanceMeters,
          } = results[n + idx];
          const busWalkMinutes = busEffectiveDistanceMeters / profile.walkSpeedMPerMin;
          const stationWalkMinutes = stationEffectiveDistanceMeters / profile.walkSpeedMPerMin;
          const coverageRatio = Math.min(
            busEffectiveDistanceMeters / BUS_COVERAGE_THRESHOLD_METERS,
            stationEffectiveDistanceMeters / STATION_COVERAGE_THRESHOLD_METERS
          );
          const isCovered = coverageRatio <= 1;
          const info: BuildingScoreInfo = {
            usage: c.usage,
            lat: c.lat,
            lng: c.lng,
            nearestStopName: c.nearestStop.name,
            busStraightDistanceMeters,
            busEffectiveDistanceMeters,
            busWalkMinutes,
            nearestStationName: c.nearestStation.name,
            stationStraightDistanceMeters,
            stationEffectiveDistanceMeters,
            stationWalkMinutes,
            coverageRatio,
            isCovered,
            totalFloorArea: c.totalFloorArea,
            walkProfileLabel: profile.label,
          };
          recordScore(c.feature, c.buildingId, info);
        });

        scheduleDemandTransitRecompute();
        return true;
      }

      // 読み込み・表示の両イベントで、未処理または再試行時刻を迎えたタイルだけ評価。
      function processTileIfNeeded(tile: Cesium.Cesium3DTile) {
        if (cancelled) return;
        void tileWork.run(tile, generation => processTile(tile, generation));
      }
      const removeLoad = tileset?.tileLoad.addEventListener(processTileIfNeeded);
      const removeVisible = tileset?.tileVisible.addEventListener(processTileIfNeeded);
      const removeUnload = tileset?.tileUnload.addEventListener(tile => tileWork.forget(tile));

      function invalidateScores() {
        const generation = tileWork.invalidate();
        buildingScoreCache.clear();
        featureScoreMap = new WeakMap();
        ++popupRequestRef.current;
        setPopup(null);
        demandTransitAnalysisMembers = null;
        demandTransitAnalysisSites = null;
        scheduleDemandTransitRecompute();
        if (analysisRequested) scheduleDemandTransitAnalysis();
        return generation;
      }
      async function applyWalkProfile(profile: WalkProfile) {
        walkProfileRef.current = profile;
        const generation = invalidateScores();
        await new Promise<void>(resolve => window.setTimeout(resolve, 800));
        if (!cancelled && generation === tileWork.generation) setCenterLoading(null);
      }
      applyWalkProfileRef.current = profile => { void applyWalkProfile(profile); };
      async function applyDistanceModel(model: DistanceModel) {
        distanceModelRef.current = model;
        const generation = invalidateScores();
        if (model === 'network') {
          const scores = await ensureNetworkScoreMap();
          if (cancelled || distanceModelRef.current !== model) return;
          if (!scores) {
            distanceModelRef.current = 'straight';
            setDistanceModel('straight');
            invalidateScores();
            setCenterLoading(null);
            setAnalysisError('道路網データを取得できなかったため、直線距離表示に戻しました。');
          }
        }
        if (!cancelled && generation === tileWork.generation && distanceModelRef.current === model) setCenterLoading(null);
      }
      applyDistanceModelRef.current = model => { void applyDistanceModel(model); };
      applyNetworkThresholdMultiplierRef.current = multiplier => {
        networkThresholdMultiplierRef.current = multiplier;
        invalidateScores();
      };
      disposeRuntime = () => {
        removeLoad?.(); removeVisible?.(); removeUnload?.();
        clickHandler.destroy();
        analysisWorker?.terminate();
        if (demandTransitRecomputeTimer) clearTimeout(demandTransitRecomputeTimer);
        if (demandTransitAnalysisTimer) clearTimeout(demandTransitAnalysisTimer);
        tileWork.invalidate();
      };

      // Cesium標準のクリック選択（selectionIndicator/infoBox）は無効化しているため、
      // バス停・建物クリック時の情報表示は自前のInfoPopupで行う。
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        ++popupRequestRef.current;
        candidatePopupRef.current = false;
        const picked = viewer.scene.pick(movement.position);
        const entity = picked?.id;
        if (entity instanceof Cesium.Entity && entity.properties?.isBusStop?.getValue()) {
          const operator: string = entity.properties.operator?.getValue();
          const routes: BusRoute[] = entity.properties.routes?.getValue() ?? [];
          const lines = [`事業者: ${operator}`];
          if (routes.length > 0) {
            lines.push(`系統: ${routes.map((r) => r.name).join("、")}`);
          }
          setPopup({ title: entity.name ?? "バス停", lines });
        } else if (entity instanceof Cesium.Entity && entity.properties?.isDemandTransitCandidate?.getValue()) {
          const candidate = demandTransitCandidates.find((c) => c.entity === entity);
          if (!candidate) {
            setPopup(null);
          } else {
            candidatePopupRef.current = true;
            const requestId = ++popupRequestRef.current;
            const avgCurrentDistance =
              candidate.members.reduce((sum, m) => sum + m.busEffectiveDistanceMeters, 0) / candidate.members.length;

            // 地区名（逆ジオコーディング）と実効距離の再計算は互いに独立した非同期処理で、
            // 完了したほうから順にポップアップへ反映する。両方の最新状態をこの2変数で保持し、
            // どちらかが完了するたびに buildLines() で組み直したポップアップを表示する。
            let areaNameText = "取得中…";
            let newDistanceLine = "新設した場合の推定実効距離: 計算中…";
            const buildLines = () => [
              `推定地区名: ${areaNameText}`,
              `対象建物数: ${candidate.members.length}棟`,
              `現状の平均実効距離（バス基準）: 約${Math.round(avgCurrentDistance)}m`,
              newDistanceLine,
            ];

            setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });

            // 逆ジオコーディング（サーバー側の/api/reverse-geocode経由でNominatimを呼ぶ）。
            void (async () => {
              try {
                const res = await fetch(
                  `/api/reverse-geocode?lat=${candidate.centroidLat}&lng=${candidate.centroidLng}`
                );
                if (!res.ok) throw new Error(`reverse-geocode API returned ${res.status}`);
                const data: { areaName: string | null } = await res.json();
                if (cancelled || requestId !== popupRequestRef.current) return;
                areaNameText = data.areaName ?? "不明";
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              } catch (err) {
                console.warn("デマンド交通乗り場候補の地区名取得に失敗しました", err);
                if (cancelled || requestId !== popupRequestRef.current) return;
                areaNameText = "取得できませんでした";
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              }
            })();

            // 実効距離の再計算（既存の傾斜込みアクセシビリティ計算と同じロジックを、
            // 目的地だけ「クリックされた候補地点」に差し替えて呼び出す）。
            void (async () => {
              try {
                if (candidate.estimatedAfter !== undefined) {
                  newDistanceLine = `新設後の平均実効距離（比較と同じ計算）: 約${Math.round(candidate.estimatedAfter)}m`;
                  if (!cancelled && requestId === popupRequestRef.current) setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
                  return;
                }
                if (distanceModelRef.current === "network") {
                  newDistanceLine = "道路網での効果は「比較グラフを表示」で計算してください";
                  if (!cancelled && requestId === popupRequestRef.current) setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
                  return;
                }
                const results = await computeEffectiveDistances(
                  terrainProvider,
                  candidate.members.map((m) => ({
                    originLat: m.lat,
                    originLng: m.lng,
                    destLat: candidate.centroidLat,
                    destLng: candidate.centroidLng,
                  })),
                  WALK_PROFILES[walkProfileRef.current].slopePenaltyFactor
                );
                // 計算中に別の候補がクリックされていたら、この結果は捨てて何もしない。
                if (cancelled || requestId !== popupRequestRef.current) return;
                const avgNewDistance =
                  results.reduce((sum, r, i) => sum + Math.min(candidate.members[i].busEffectiveDistanceMeters, r.effectiveDistanceMeters), 0) / results.length;
                newDistanceLine = `新設した場合の推定実効距離: 約${Math.round(avgNewDistance)}m`;
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              } catch (err) {
                console.warn("デマンド交通乗り場候補の再計算に失敗しました", err);
                if (cancelled || requestId !== popupRequestRef.current) return;
                newDistanceLine = "新設した場合の推定実効距離: 計算に失敗しました";
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              }
            })();
          }
        } else if (entity instanceof Cesium.Entity && entity.properties?.isExistingDemandTransit?.getValue()) {
          const service: ExistingDemandTransitService = entity.properties.service.getValue();
          const stopName: string = entity.properties.stopName.getValue();
          setPopup({
            title: `${service.name}（${stopName}）`,
            lines: [
              `種別: ${service.type}`,
              `事業者: ${service.operator}`,
              `運行開始: ${service.startDate}`,
              service.description,
              <a key="src" href={service.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#93c5fd" }}>
                藤沢市公式ページ
              </a>,
            ],
          });
        } else if (entity instanceof Cesium.Entity && entity.properties?.isHelloCyclingStation?.getValue()) {
          const capacity: number | null = entity.properties.capacity?.getValue() ?? null;
          setPopup({
            title: entity.name ?? "ハローサイクリング ステーション",
            lines: [...(capacity != null ? [`収容可能台数: ${capacity}台`] : [])],
          });
        } else if (picked instanceof Cesium.Cesium3DTileFeature) {
          const info = featureScoreMap.get(picked);
          if (info) {
            setPopup({
              title: info.usage,
              lines: [
                `判定: ${info.isCovered ? "カバーされている" : "交通空白地"}`,
                `最寄りバス停: ${info.nearestStopName}（実効距離 約${Math.round(info.busEffectiveDistanceMeters)}m・徒歩${Math.round(info.busWalkMinutes)}分）`,
                `最寄り鉄道駅: ${info.nearestStationName}（実効距離 約${Math.round(info.stationEffectiveDistanceMeters)}m・徒歩${Math.round(info.stationWalkMinutes)}分）`,
                ...(info.totalFloorArea != null ? [`延床面積: 約${Math.round(info.totalFloorArea)}m²`] : []),
                `プロファイル: ${info.walkProfileLabel}`,
              ],
            });
          } else {
            setPopup(null);
          }
        } else {
          setPopup(null);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      // 起動時のカメラ視点を設定（BoundingSphereで中心点と半径を合わせる）。
      const center = Cesium.Cartesian3.fromDegrees(
        INITIAL_VIEW_CENTER_LNG,
        INITIAL_VIEW_CENTER_LAT
      );
      const sphere = new Cesium.BoundingSphere(center, INITIAL_VIEW_RADIUS_METERS);
      viewer.camera.flyToBoundingSphere(sphere, {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(INITIAL_VIEW_HEADING),
          Cesium.Math.toRadians(INITIAL_VIEW_PITCH)
        ),
        duration: 0,
      });
    }

    init();

    return () => {
      cancelled = true;
      disposeRuntime();
      scheduleDemandTransitRecomputeRef.current = null;
      scheduleDemandTransitAnalysisRef.current = null;
      applyWalkProfileRef.current = null;
      applyDistanceModelRef.current = null;
      applyNetworkThresholdMultiplierRef.current = null;
      helloCyclingEntitiesRef.current = [];
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <Legend
        clusterCount={demandTransitClusterCount}
        analysisThresholdMultiplier={demandTransitAnalysisThresholdMultiplier}
        showHelloCycling={showHelloCycling}
        walkProfile={walkProfile}
        distanceModel={distanceModel}
        loadingNetworkScores={loadingNetworkScores}
        networkThresholdMultiplier={networkThresholdMultiplier}
        showExperimentalDistanceModel={showExperimentalDistanceModel}
        onClusterCountChange={(value) => {
          demandTransitClusterCountRef.current = value;
          setDemandTransitClusterCount(value);
          scheduleDemandTransitRecomputeRef.current?.();
        }}
        onAnalysisThresholdMultiplierChange={(value) => {
          // ドラッグ中の細かな変化はinit側でまとめ、操作が止まった条件だけを再計算する。
          // 既存のグラフはローディング表示の下に残し、完了時に新条件の結果へ差し替える。
          demandTransitAnalysisThresholdMultiplierRef.current = value;
          setDemandTransitAnalysisThresholdMultiplier(value);
          if (demandTransitPlanAnalysis || isDemandTransitPanelVisible) {
            scheduleDemandTransitAnalysisRef.current?.();
          }
        }}
        onShowHelloCyclingChange={setShowHelloCycling}
        onWalkProfileChange={(value) => {
          setWalkProfile(value);
          setCenterLoading({
            title: `${WALK_PROFILES[value].label}を反映中…`,
            subtitle: "建物の坂道負荷・歩行速度を再計算しています",
          });
          applyWalkProfileRef.current?.(value);
        }}
        onDistanceModelChange={(value) => {
          setDistanceModel(value);
          setCenterLoading({
            title: value === "network" ? "道路網距離を反映中…" : "直線距離モデルを反映中…",
            subtitle: "建物の距離基準を切り替えています",
          });
          applyDistanceModelRef.current?.(value);
        }}
        onNetworkThresholdMultiplierChange={(value) => {
          setNetworkThresholdMultiplier(value);
          applyNetworkThresholdMultiplierRef.current?.(value);
        }}
        onToggleExperimentalDistanceModel={setShowExperimentalDistanceModel}
        isDemandTransitAnalysisRunning={isDemandTransitAnalysisRunning}
        isDemandTransitPanelVisible={isDemandTransitPanelVisible}
        onShowDemandTransitPanel={() => {
          setIsDemandTransitPanelVisible(true);
          if (!demandTransitPlanAnalysis && !isDemandTransitAnalysisRunning) {
            scheduleDemandTransitAnalysisRef.current?.(0);
          }
        }}
      />
      {analysisError && <div role="alert" style={{position:'absolute',right:12,top:12,zIndex:20,maxWidth:360,padding:12,background:'#7f1d1d',color:'white'}}>{analysisError}<button onClick={()=>setAnalysisError(null)} aria-label="通知を閉じる">×</button></div>}
      <UncoloredBuildingsNote />
      <DemandTransitRecommendationPanel
        analysis={demandTransitPlanAnalysis}
        selectedCount={demandTransitClusterCount}
        isRunning={isDemandTransitAnalysisRunning}
        pendingThresholdMultiplier={demandTransitAnalysisThresholdMultiplier}
        isVisible={isDemandTransitPanelVisible}
        onClose={() => setIsDemandTransitPanelVisible(false)}
      />
      {popup && <InfoPopup info={popup} onClose={() => { ++popupRequestRef.current; candidatePopupRef.current = false; setPopup(null); }} />}
      <CenterLoadingIndicator loadingState={centerLoading} />
    </div>
  );
}
