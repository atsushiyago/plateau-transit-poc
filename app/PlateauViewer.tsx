"use client";

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

// 初期カメラの表示範囲（バス停群の重心を中心とした固定半径）。バス停全件（南北東西とも
// 十数km）にフィットさせると、建物1棟が画面上で数ピクセルしかなく色分けがほぼ見えない状態に
// なっていた。全件を収める代わりに、重心付近の一定範囲だけを最初から映すことで、開いた直後から
// 色分けされた建物がある程度画面いっぱいに見えるようにする（残りのエリアはズームアウト/パンして
// 確認する）。
const INITIAL_VIEW_RADIUS_METERS = 900;

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

// 鉄道駅データ（藤沢市北部、5駅）。新規にOverpassクエリを実行したものではなく、
// `public/data/place-labels.json`の抽出時（AGENTS.md「地名ラベル・逆ジオコーディングについて」
// 第1段階、railway=station/halt）で既に取得済みだった5駅（六会日大前・善行・湘南台・
// 藤沢本町・長後）をそのまま切り出したもの。place-labels.jsonは表示用でtype情報を持たないため、
// 判定計算用に別ファイルとして`train-stations.json`を用意している。
const TRAIN_STATIONS_JSON_URL = "/data/train-stations.json";
type TrainStation = { name: string; lat: number; lng: number };

// 藤沢市公式の「交通空白地」定義（メンター自治体への質問への回答で確認済み、2026年8月）:
// 「鉄道駅から600m圏、バス停から300m圏（高齢者の移動を考慮した基準）に入らないエリア」。
// このPoCでは傾斜込みの実効距離をこの2つの閾値と比較し、どちらか一方でも満たせば
// 「カバーされている」と判定する（OR条件）。詳細はAGENTS.md「藤沢市公式の交通空白地判定基準への
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
const MAX_SCORED_BUILDINGS = 20000;
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
type WalkProfile = "general" | "elderly";
const WALK_PROFILES: Record<WalkProfile, { label: string; slopePenaltyFactor: number; walkSpeedMPerMin: number }> = {
  // 勾配1あたり実効距離を何倍割り増しするかの係数。例: 勾配0.1(10%)ならslopePenaltyFactor=3で
  // 実効距離が1.3倍になる。徒歩速度は分速67m≒時速4kmが一般的な成人の目安。
  general: { label: "一般", slopePenaltyFactor: 3, walkSpeedMPerMin: 67 },
  elderly: { label: "高齢者（坂道に配慮）", slopePenaltyFactor: 6, walkSpeedMPerMin: 50 },
};
const WALK_PROFILE_DEFAULT: WalkProfile = "general";

// 【feature/road-network-distanceブランチ限定・実験的】直線距離モデル（デフォルト、mainと同じ
// ライブ計算）と、道路網距離モデル（scripts/road-network/で事前計算したbuilding-network-scores.json
// を読み込むだけ）を、ブラウザ上で切り替えて見比べられるようにするためのトグル。
// ユーザーから「別ブランチで動かしたら空白地の色付けがどれくらい変わるのか見たい」との要望を受けて、
// mainとブランチを行き来せず同じ画面上で比較できるよう追加した（あくまで視覚比較用の一時的な
// 実装であり、本採用するかどうかは別途判断する）。
type DistanceModel = "straight" | "network";
const DISTANCE_MODEL_DEFAULT: DistanceModel = "straight";
const BUILDING_NETWORK_SCORES_JSON_URL = "/data/building-network-scores.json";
type BuildingNetworkScoreRow = {
  buildingId: string;
  busNetworkDistanceM: number;
  stationNetworkDistanceM: number;
  busEffectiveDistanceM_general: number;
  stationEffectiveDistanceM_general: number;
  coverageRatio_general: number;
  busEffectiveDistanceM_elderly: number;
  stationEffectiveDistanceM_elderly: number;
  coverageRatio_elderly: number;
  nearestStopName: string;
  nearestStationName: string;
};

// 建物ごとの「カバー率」= min(バス実効距離/BUS_COVERAGE_THRESHOLD_METERS, 駅実効距離/
// STATION_COVERAGE_THRESHOLD_METERS)。閾値の単位（300m/600m）が異なる駅・バスの2つの基準を
// ORで比較するための正規化で、ratio<=1ならどちらか一方の基準を満たす＝「カバーされている」。
// ratio>1の超過分を、津波浸水深の色分け（plateau-poc の FLOOD_RANKS）と同じ考え方で
// 赤系4段階のグラデーションに割り当てる（緑1色+赤系4段階のシンプルな2値+グラデーション）。
const COVERAGE_RANKS: { maxRatio: number; legendLabel: string; color: Cesium.Color }[] = [
  { maxRatio: 1, legendLabel: "カバーされている", color: Cesium.Color.fromCssColorString("#22c55e") },
  { maxRatio: 1.5, legendLabel: "空白地（僅かに超過）", color: Cesium.Color.fromCssColorString("#fecaca") },
  { maxRatio: 2, legendLabel: "空白地（やや遠い）", color: Cesium.Color.fromCssColorString("#f87171") },
  { maxRatio: 3, legendLabel: "空白地（遠い）", color: Cesium.Color.fromCssColorString("#dc2626") },
  { maxRatio: Infinity, legendLabel: "空白地（非常に遠い）", color: Cesium.Color.fromCssColorString("#7f1d1d") },
];

function colorForCoverageRatio(ratio: number): Cesium.Color {
  const rank = COVERAGE_RANKS.find((r) => ratio <= r.maxRatio) ?? COVERAGE_RANKS[COVERAGE_RANKS.length - 1];
  return rank.color;
}

const EARTH_RADIUS_METERS = 6371000;
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    const heights = sampled.slice(start, end).map((carto) => carto.height ?? 0);
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

// デマンド交通乗り場候補: 藤沢市公式の交通空白地判定（COVERAGE_RANKS参照）でカバーされていない
// （coverageRatioが一定倍率を超える）住宅系建物の座標にk-meansクラスタリングをかけ、クラスタ重心を
// 「新しい乗り場を置くならここ」の候補地点として提案する。
// 【方針決定】当初はバス実効距離のメートル閾値で判定していたが、藤沢市公式の交通空白地判定
// （駅600m or バス300mのOR条件）に統一した。倍率のデフォルト1.0は「公式の空白地基準を1件でも
// 満たさない＝空白地」に完全一致する。1.0より大きくすると「公式基準をさらに◯倍超過している、
// より深刻なエリアだけに絞り込む」という優先順位付けツールとして機能する。
// 対象倍率・候補数は、藤沢市の担当者が現場感覚に合わせてその場で調整できるよう
// 左上のLegend内のスライダーで変更可能にしている（下記のuseState/refで管理。この2つの
// 定数は初期値としてのみ使う）。
const DEMAND_TRANSIT_GAP_RATIO_THRESHOLD_DEFAULT = 1.0;
const DEMAND_TRANSIT_CLUSTER_COUNT_DEFAULT = 4;
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

// 藤沢市が既に運行している乗合タクシー・オンデマンドバス（天神町AIオンデマンドバス、のりあい善行、
// おでかけ六会）を、このPoCが提案する「デマンド交通乗り場候補」（紫の四角ピン）と区別できる形で
// 地図上にオーバーレイ表示する。「このPoCは市の既存の取り組みと無関係に候補を出しているのではなく、
// 市がまだ手を付けていない場所を見つけるための優先順位付けツールである」ことを示すための機能
// （ユーザーからのフィードバックで追加、詳細はセッションのやり取り参照）。
// 中心座標・半径は、各サービスの公式ページに正確な運行エリア境界（丁目リストや地図）が
// 掲載されていなかったため、以下の方法で機械的に算出した近似値（`public/data/existing-demand-transit.json`
// の`areaConfidence`で精度の目安を区別）:
// - 天神町（areaConfidence: "high"）: public/data/bus-stops.json内の「天神町」始まりの停留所10件
//   （天神町循環線の実際の停留所と一致すると考えられる）の重心・最大距離から算出
// - のりあい善行・おでかけ六会（areaConfidence: "low"）: 公式ページに記載された行き先地名
//   （亀井野・立石・善行駅、西俣野・六会日大前駅）をplace-labels.json/train-stations.jsonから
//   引き、その平均座標・最大距離から算出した目安（実際の運行区域とは異なる可能性がある）
const EXISTING_DEMAND_TRANSIT_JSON_URL = "/data/existing-demand-transit.json";
type ExistingDemandTransitService = {
  name: string;
  type: string;
  operator: string;
  startDate: string;
  description: string;
  sourceUrl: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  areaConfidence: "high" | "low";
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
function projectToLocalMeters(lat: number, lng: number, refLat: number, refLng: number): [number, number] {
  const refLatRad = (refLat * Math.PI) / 180;
  return [(lng - refLng) * 111320 * Math.cos(refLatRad), (lat - refLat) * 110540];
}
function unprojectFromLocalMeters(x: number, y: number, refLat: number, refLng: number): [number, number] {
  const refLatRad = (refLat * Math.PI) / 180;
  return [refLat + y / 110540, refLng + x / (111320 * Math.cos(refLatRad))];
}

// シンプルなk-means実装（Lloyd法）。既存の依存関係に軽量なk-means実装が無いため自前で用意する。
// 初期中心点はx座標でソートしてk等分した位置から選ぶ決定的な方法（乱数を使わず、毎回同じ結果になる）。
function kMeans(
  points: [number, number][],
  k: number,
  maxIterations = 20
): { centroid: [number, number]; indices: number[] }[] {
  if (points.length === 0 || k <= 0) return [];
  const effectiveK = Math.min(k, points.length);
  const sortedIndices = [...points.keys()].sort((a, b) => points[a][0] - points[b][0]);
  let centroids: [number, number][] = Array.from({ length: effectiveK }, (_, i) => {
    const idx = sortedIndices[Math.floor(((i + 0.5) * points.length) / effectiveK)];
    return [points[idx][0], points[idx][1]];
  });
  const assignments = new Array(points.length).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < effectiveK; c++) {
        const dx = points[i][0] - centroids[c][0];
        const dy = points[i][1] - centroids[c][1];
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const sums: [number, number][] = Array.from({ length: effectiveK }, () => [0, 0]);
    const counts = new Array(effectiveK).fill(0);
    for (let i = 0; i < points.length; i++) {
      const c = assignments[i];
      sums[c][0] += points[i][0];
      sums[c][1] += points[i][1];
      counts[c]++;
    }
    centroids = centroids.map((prev, c) => (counts[c] > 0 ? [sums[c][0] / counts[c], sums[c][1] / counts[c]] : prev));

    if (!changed) break;
  }

  const groups: number[][] = Array.from({ length: effectiveK }, () => []);
  for (let i = 0; i < points.length; i++) {
    groups[assignments[i]].push(i);
  }
  return centroids.map((centroid, c) => ({ centroid, indices: groups[c] })).filter((g) => g.indices.length > 0);
}

// デマンド交通乗り場候補ピンを、既存の丸ピン（バス停等）と見た目で区別するため、
// canvasで紫の四角アイコンを生成してbillboard画像として使う。
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
        right: 12,
        top: 12,
        zIndex: 10,
        background: "rgba(20, 20, 20, 0.85)",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: 6,
        fontSize: 13,
        lineHeight: 1.6,
        fontFamily: "sans-serif",
        maxWidth: 280,
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
  gapThreshold,
  clusterCount,
  showHelloCycling,
  walkProfile,
  distanceModel,
  loadingNetworkScores,
  onGapThresholdChange,
  onClusterCountChange,
  onShowHelloCyclingChange,
  onWalkProfileChange,
  onDistanceModelChange,
}: {
  gapThreshold: number;
  clusterCount: number;
  showHelloCycling: boolean;
  walkProfile: WalkProfile;
  distanceModel: DistanceModel;
  loadingNetworkScores: boolean;
  onGapThresholdChange: (value: number) => void;
  onClusterCountChange: (value: number) => void;
  onShowHelloCyclingChange: (value: boolean) => void;
  onWalkProfileChange: (value: WalkProfile) => void;
  onDistanceModelChange: (value: DistanceModel) => void;
}) {
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
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 4 }}>藤沢市公式の交通空白地判定基準</div>
      <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
        鉄道駅600m圏 or バス停300m圏（いずれも傾斜考慮の実効距離）のOR判定
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
        <div style={{ opacity: 0.85, marginBottom: 2 }}>
          距離モデル(実験的、feature/road-network-distanceのみ):
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="radio"
            name="distanceModel"
            checked={distanceModel === "straight"}
            disabled={loadingNetworkScores}
            onChange={() => onDistanceModelChange("straight")}
          />
          <span>直線距離(main相当)</span>
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
          <span>対象とする空白の深刻度（公式基準の超過倍率）: {gapThreshold.toFixed(1)}倍〜</span>
        </label>
        <input
          type="range"
          min={1}
          max={3}
          step={0.1}
          value={gapThreshold}
          onChange={(e) => onGapThresholdChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ marginTop: 4 }}>
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
      白い建物は色分けの対象外です（住宅系以外の用途、または用途不明の建物。表示直後は読み込み中の場合もあります）
    </div>
  );
}

// 面積カバー率（藤沢市北部エリア全体のうち、駅600m or バス300mでカバーされる面積の割合）は、
// アプリ内でライブ計算すると藤沢市北部全域を格子点でスキャンする必要があり重いため、
// このセッションでオフラインのPythonスクリプト（Shapelyで藤沢市行政境界ポリゴンを取得し、
// 50m間隔の格子点21,773点をHaversine直線距離で判定。地形サンプリングはせず傾斜未考慮）で
// 事前計算した値を定数として埋め込んでいる（2026年8月時点、`public/data/bus-stops.json`の
// 主要事業者バス停297件・`public/data/train-stations.json`の5駅が対象）。詳細はAGENTS.md参照。
const OFFLINE_AREA_COVERAGE_RATIO = 0.717;
// 藤沢市公式資料の面積カバー率（藤沢市全域、メンター自治体への質問で確認）。本PoCの対象は
// 藤沢市"北部"のみ（交通の便が比較的悪いエリアに絞って可視化する趣旨のため）なので、
// 藤沢市全域より低めに出ること自体は想定内（詳細はAGENTS.md参照）。
const OFFICIAL_AREA_COVERAGE_RATIO = 0.78;

// 「建物カバー率」（読み込み済みの住宅系建物のうちカバーされている割合、リアルタイム）と、
// 「面積カバー率」（上記の事前計算値）を藤沢市公式資料の数値と並べて表示する。左下は
// 現在未使用の角（左上=Legend、右上=InfoPopup、右下=UncoloredBuildingsNote）。
function CoverageStatsPanel({ covered, total }: { covered: number; total: number }) {
  const buildingRatio = total > 0 ? (covered / total) * 100 : null;
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        // Cesium標準のクレジット表示（"Cesium ion"ロゴ＋著作権テキスト）が画面左下に
        // デフォルトで表示され、bottom: 12だとこのパネルの最終行（藤沢市公式資料の行）と
        // 重なって読めなくなっていた。クレジット表示の高さぶん余白を空けて回避する。
        bottom: 32,
        zIndex: 10,
        background: "rgba(20, 20, 20, 0.75)",
        color: "#fff",
        padding: "8px 10px",
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1.6,
        fontFamily: "sans-serif",
        maxWidth: 280,
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 2 }}>カバー率（藤沢市公式基準）</div>
      <div>
        建物カバー率（読み込み済み{total}棟中、リアルタイム）: {buildingRatio !== null ? `${buildingRatio.toFixed(1)}%` : "計算中…"}
      </div>
      <div>面積カバー率（藤沢市北部・事前計算の格子点分析）: {(OFFLINE_AREA_COVERAGE_RATIO * 100).toFixed(1)}%</div>
      <div style={{ opacity: 0.75 }}>参考: 藤沢市公式資料（市全域）: {(OFFICIAL_AREA_COVERAGE_RATIO * 100).toFixed(0)}%</div>
    </div>
  );
}

export default function PlateauViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [popup, setPopup] = useState<PopupInfo | null>(null);
  const [demandTransitGapThreshold, setDemandTransitGapThreshold] = useState(
    DEMAND_TRANSIT_GAP_RATIO_THRESHOLD_DEFAULT
  );
  const [demandTransitClusterCount, setDemandTransitClusterCount] = useState(
    DEMAND_TRANSIT_CLUSTER_COUNT_DEFAULT
  );
  // ハローサイクリングのステーションピンの表示/非表示トグル（デフォルトON）。既存のスライダーと
  // 同じ「Legend内のUIでReact stateを変更し、init()内で作られたCesiumエンティティに反映する」
  // 方式を踏襲するが、こちらは再クラスタリングのような重い再計算が不要なため、
  // helloCyclingEntitiesRefに保持した各エンティティのentity.showを直接切り替えるだけで済む。
  const [showHelloCycling, setShowHelloCycling] = useState(true);
  // 勾配感度・歩行速度のプロファイル（「一般」/「高齢者」）。切り替えるとbuildingScoreCacheが
  // 全建物ぶん無効化され、読み込み済みの建物すべてを新しいプロファイルで再計算する（詳細は
  // applyWalkProfileのコメント参照）。
  const [walkProfile, setWalkProfile] = useState<WalkProfile>(WALK_PROFILE_DEFAULT);
  // 【実験的】直線距離モデル/道路網距離モデルの切り替え（詳細はDistanceModelのコメント参照）。
  const [distanceModel, setDistanceModel] = useState<DistanceModel>(DISTANCE_MODEL_DEFAULT);
  // "network"に初めて切り替えたときに44.5MBのJSONを遅延読み込みする。読み込み中はtrueにして
  // Legendのラジオボタンを一時的に操作不能にし、多重フェッチを防ぐ。
  const [loadingNetworkScores, setLoadingNetworkScores] = useState(false);
  // カバレッジ統計パネル（画面左下）表示用。processTileが新しい建物をスコア計算するたびに
  // 更新する（buildingScoreCacheの内容そのものはReact stateの外で管理しているため、
  // 表示用にこのstateだけ都度setする軽量なミラー）。
  const [coverageStats, setCoverageStats] = useState({ covered: 0, total: 0 });
  // Cesiumのイベントハンドラ（init()内のクロージャ）はマウント時に1度だけ作られ、Reactの
  // 再レンダリングでは作り直されないため、スライダーの最新値をそのクロージャから読めるように
  // refで橋渡しする（値が変わるたびにrefだけ更新し、Viewer自体は再構築しない）。
  const demandTransitGapThresholdRef = useRef(demandTransitGapThreshold);
  const demandTransitClusterCountRef = useRef(demandTransitClusterCount);
  const walkProfileRef = useRef(walkProfile);
  const distanceModelRef = useRef(distanceModel);
  useEffect(() => {
    demandTransitGapThresholdRef.current = demandTransitGapThreshold;
    demandTransitClusterCountRef.current = demandTransitClusterCount;
    walkProfileRef.current = walkProfile;
    distanceModelRef.current = distanceModel;
  }, [demandTransitGapThreshold, demandTransitClusterCount, walkProfile, distanceModel]);
  // init()内で定義されるscheduleDemandTransitRecomputeをスライダーのonChangeから呼べるように
  // するための橋渡し。Viewerがまだ初期化中の場合はnullのままで、呼び出し側でガードする。
  const scheduleDemandTransitRecomputeRef = useRef<(() => void) | null>(null);
  // プロファイル切り替えのonChangeから呼べるようにするための橋渡し。walkProfileRef.currentを
  // 同期的に更新してからbuildingScoreCacheを無効化・再計算するため、上のuseEffect経由の
  // 非同期な同期だと間に合わない（イベントハンドラ内でsetWalkProfileした直後にこの関数を
  // 呼ぶと、re-render前なのでuseEffectがまだ走っていない）。そのためinit()側の関数自身が
  // walkProfileRef.currentを直接書き換える。
  const applyWalkProfileRef = useRef<((profile: WalkProfile) => void) | null>(null);
  // 【実験的】距離モデル切り替えのonChangeから呼べるようにするための橋渡し（applyWalkProfileRefと同じ理由）。
  const applyDistanceModelRef = useRef<((model: DistanceModel) => void) | null>(null);
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

      // 藤沢市公式の交通空白地判定（駅600m圏）に使う鉄道駅データを読み込む。
      let trainStationList: TrainStation[] = [];
      try {
        const res = await fetch(TRAIN_STATIONS_JSON_URL);
        const data: { stations: TrainStation[] } = await res.json();
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

      // 藤沢市が既に運行している乗合タクシー・オンデマンドバスの拠点を、青い円ピン＋半透明の
      // 概算エリア（円）でオーバーレイ表示する。デマンド交通候補（紫の四角、このPoCの提案）と
      // 見た目で明確に区別することで、「市の既存の取り組みを無視して候補を出しているのではない」
      // ことを示す（詳細は上記EXISTING_DEMAND_TRANSIT_JSON_URLのコメント参照）。
      try {
        const res = await fetch(EXISTING_DEMAND_TRANSIT_JSON_URL);
        const data: { services: ExistingDemandTransitService[] } = await res.json();
        if (cancelled) return;
        const existingDemandTransitIconUrl = createCircleIconDataUrl(
          EXISTING_DEMAND_TRANSIT_COLOR.toCssColorString()
        );
        for (const service of data.services) {
          viewer.entities.add({
            name: service.name,
            position: Cesium.Cartesian3.fromDegrees(service.lng, service.lat),
            properties: { isExistingDemandTransit: true, service },
            // heightもheightReferenceも指定しないと、Cesiumはこのellipseを自動的に
            // ClampToGroundのGroundPrimitiveとして地形に貼り付ける（Entity APIの標準的な挙動）。
            // ただしこの描画方式は仕様上outline付き描画に対応していないため、outlineは付けない
            // （付けても警告が出て無視されるだけ）。
            ellipse: {
              semiMinorAxis: service.radiusMeters,
              semiMajorAxis: service.radiusMeters,
              material: EXISTING_DEMAND_TRANSIT_COLOR.withAlpha(0.12),
            },
            billboard: {
              image: existingDemandTransitIconUrl,
              width: 20,
              height: 20,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
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

      // 住宅系建物ごとに「最寄りバス停・最寄り駅までの傾斜込み実効距離」を計算し、藤沢市公式の
      // 交通空白地判定（駅600m or バス300mのOR）で3D Tilesのフィーチャーを直接色分けする。
      // buildingScoreCache は建物ID(_x,_yから作る代替IDを含む)をキーに永続化し、タイルが
      // アンロード→再ロードされて新しいCesium3DTileFeatureインスタンスになった場合でも
      // 地形サンプリングをやり直さずに再着色できるようにする。featureScoreMapは
      // クリック時に「今画面にある生きたfeatureオブジェクト」からスコア情報を引くためのWeakMap。
      type CachedScore = { color: Cesium.Color; info: BuildingScoreInfo };
      const buildingScoreCache = new Map<string, CachedScore>();
      const featureScoreMap = new WeakMap<Cesium.Cesium3DTileFeature, BuildingScoreInfo>();
      // 【実験的】道路網距離モデル用の事前計算データ（scripts/road-network/03_compute_scores.py
      // の出力）。"network"に初めて切り替えたときにapplyDistanceModelが遅延フェッチしてここへ
      // 格納する。buildingIdをキーに直接引けるので、該当する建物は地形サンプリング不要で
      // 即座に色を決められる。
      let networkScoreMap: Map<string, BuildingNetworkScoreRow> | null = null;
      // カバレッジ統計パネル（画面左下）用の累計カウンタ。buildingScoreCacheに新規登録される
      // たびに更新し、キャッシュヒット（再着色のみ）では増やさない。
      let scoredCoveredCount = 0;
      let scoredTotalCount = 0;
      // 勾配プロファイル（一般/高齢者）切り替え用の「世代」カウンタ。applyWalkProfileが
      // 呼ばれるたびに+1し、buildingScoreCacheを空にする。tileScannedGenerationは
      // 「このタイルを最後に処理したときの世代」をタイルごとに記録するWeakMapで、
      // processTileIfNeeded（tileLoad/tileVisible両方から呼ばれる）が「このタイルは
      // 現在の世代でまだ処理していない」ときだけ実際のprocessTileを呼ぶためのガードに使う。
      // Cesium3DTilesetには「現在ロード済みの全タイルを走査する」ような公開APIが無いため、
      // 代わりにtileVisible（画面に映るたびに毎フレーム発火するイベント）に安価なチェックだけ
      // 常時ぶら下げておき、世代が古いタイルが画面に映った瞬間に自己修復的に再計算させる方式にした
      // （オフスクリーンのタイルも、後で画面に戻ってきたときに正しく新しい世代で再計算される）。
      let scoreGeneration = 0;
      const tileScannedGeneration = new WeakMap<Cesium.Cesium3DTile, number>();

      // デマンド交通乗り場候補（k-meansのクラスタ重心）を紫の四角ピンで表示する。
      // 建物のスコア計算が進むたびに（buildingScoreCacheが更新されるたびに）再クラスタリングする
      // 必要があるため、候補ピンの実体（Entity）とクラスタ内訳（members）を紐付けて保持しておく
      // （クリック時に「対象建物数」「現状の平均実効距離」を即座に表示するため）。
      // busEffectiveDistanceMetersを表示用に保持している（対象建物のほとんどはバス距離が
      // カバー率のボトルネックになるため、代表的な指標として引き続きバス実効距離を見せる。
      // 抽出基準そのものはcoverageRatioの閾値なので、駅が近くバスが遠い建物も理論上は含まれ得る）。
      type DemandTransitMember = { lat: number; lng: number; busEffectiveDistanceMeters: number };
      type DemandTransitCandidate = {
        entity: Cesium.Entity;
        centroidLat: number;
        centroidLng: number;
        members: DemandTransitMember[];
      };
      let demandTransitCandidates: DemandTransitCandidate[] = [];
      let demandTransitRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
      // クリックのたびにインクリメントし、非同期の「新設した場合の推定実効距離」計算が
      // 完了した時点で最新のクリックと一致するかを確認する（古いリクエストの結果で
      // ポップアップを上書きしないようにするため）。
      let demandTransitRequestId = 0;
      const demandTransitIconUrl = createSquareIconDataUrl(DEMAND_TRANSIT_COLOR);

      function recomputeDemandTransitCandidates() {
        if (cancelled) return;
        const gapBuildings: DemandTransitMember[] = [];
        for (const { info } of buildingScoreCache.values()) {
          if (info.coverageRatio > demandTransitGapThresholdRef.current) {
            gapBuildings.push({ lat: info.lat, lng: info.lng, busEffectiveDistanceMeters: info.busEffectiveDistanceMeters });
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
        const clusters = kMeans(projected, demandTransitClusterCountRef.current);

        for (const cluster of clusters) {
          const [centroidLat, centroidLng] = unprojectFromLocalMeters(
            cluster.centroid[0],
            cluster.centroid[1],
            refLat,
            refLng
          );
          const members = cluster.indices.map((i) => gapBuildings[i]);
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
          demandTransitCandidates.push({ entity, centroidLat, centroidLng, members });
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

      async function processTile(tile: Cesium.Cesium3DTile) {
        if (tokaidoLinePoints.length === 0 || majorOperatorStopList.length === 0 || trainStationList.length === 0) return;
        const content = tile.content;
        if (!content || content.featuresLength === 0) return;
        if (buildingScoreCache.size >= MAX_SCORED_BUILDINGS) return;

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
          if (buildingScoreCache.size + candidates.length >= MAX_SCORED_BUILDINGS) continue;

          const totalFloorArea = feature.getProperty(
            "uro:BuildingDetailAttribute_uro:totalFloorArea"
          ) as number | null | undefined;
          candidates.push({ feature, buildingId, lng, lat, usage, totalFloorArea: totalFloorArea ?? null });
        }

        if (candidates.length === 0) return;

        const profile = WALK_PROFILES[walkProfileRef.current];

        // buildingScoreCache/featureScoreMapへの登録・色付け・カウンタ更新を1箇所にまとめた
        // ヘルパー。直線距離モデル（ライブ計算）・道路網距離モデル（事前計算データ）の
        // どちらの経路からも同じ形で呼べるようにしている。
        function recordScore(feature: Cesium.Cesium3DTileFeature, buildingId: string, info: BuildingScoreInfo) {
          const color = colorForCoverageRatio(info.coverageRatio);
          feature.color = color;
          buildingScoreCache.set(buildingId, { color, info });
          featureScoreMap.set(feature, info);
          scoredTotalCount++;
          if (info.isCovered) scoredCoveredCount++;
        }

        // 【実験的】道路網距離モデルが選択されていて事前計算データが読み込み済みなら、該当する
        // 建物はそちらの数値をそのまま使う（地形サンプリング不要）。事前計算データに無い建物
        // （オフライン抽出と実行タイミングがズレて生じた差分等）は直線距離モデルにフォールバックする。
        let liveCandidates = candidates;
        if (distanceModelRef.current === "network" && networkScoreMap) {
          liveCandidates = [];
          for (const c of candidates) {
            const row = networkScoreMap.get(c.buildingId);
            if (!row) {
              liveCandidates.push(c);
              continue;
            }
            const busEff =
              walkProfileRef.current === "general" ? row.busEffectiveDistanceM_general : row.busEffectiveDistanceM_elderly;
            const stationEff =
              walkProfileRef.current === "general"
                ? row.stationEffectiveDistanceM_general
                : row.stationEffectiveDistanceM_elderly;
            const coverageRatio =
              walkProfileRef.current === "general" ? row.coverageRatio_general : row.coverageRatio_elderly;
            const info: BuildingScoreInfo = {
              usage: c.usage,
              lat: c.lat,
              lng: c.lng,
              nearestStopName: row.nearestStopName,
              // 道路網距離モデルには「直線距離」の概念が無いため、勾配加味前の道路網距離を代用する
              // （現状のUIはこの値を表示していないため実用上の影響はない）。
              busStraightDistanceMeters: row.busNetworkDistanceM,
              busEffectiveDistanceMeters: busEff,
              busWalkMinutes: busEff / profile.walkSpeedMPerMin,
              nearestStationName: row.nearestStationName,
              stationStraightDistanceMeters: row.stationNetworkDistanceM,
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
          setCoverageStats({ covered: scoredCoveredCount, total: scoredTotalCount });
          scheduleDemandTransitRecompute();
          return;
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
          return;
        }
        if (cancelled) return;

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
        setCoverageStats({ covered: scoredCoveredCount, total: scoredTotalCount });

        scheduleDemandTransitRecompute();
      }

      // tileLoad（新規タイルの読み込み完了時）・tileVisible（タイルが画面に映るたびに毎フレーム
      // 発火）の両方からこのラッパー経由でprocessTileを呼ぶ。tileScannedGenerationに
      // 記録した「最後に処理した世代」が現在のscoreGenerationと一致していれば何もしない
      // （WeakMap.get + 比較だけの安価なチェックなので、tileVisibleの高頻度発火でも問題にならない）。
      function processTileIfNeeded(tile: Cesium.Cesium3DTile) {
        if (tileScannedGeneration.get(tile) === scoreGeneration) return;
        tileScannedGeneration.set(tile, scoreGeneration);
        void processTile(tile);
      }
      tileset?.tileLoad.addEventListener(processTileIfNeeded);
      tileset?.tileVisible.addEventListener(processTileIfNeeded);

      // 勾配プロファイル（一般/高齢者）が切り替わったときに呼ぶ。実効距離・coverageRatioは
      // プロファイルに依存するため、buildingScoreCacheに入っている既存の計算結果はすべて古くなる。
      // scoreGenerationを進めてキャッシュを空にするだけで、実際の再計算はprocessTileIfNeededが
      // tileVisibleイベント経由で自己修復的に行う（画面内のタイルは次のフレームで、画面外の
      // タイルも後で映ったときに正しく再計算される）。
      function applyWalkProfile(profile: WalkProfile) {
        walkProfileRef.current = profile;
        scoreGeneration++;
        buildingScoreCache.clear();
        scoredCoveredCount = 0;
        scoredTotalCount = 0;
        setCoverageStats({ covered: 0, total: 0 });
        scheduleDemandTransitRecompute();
      }
      applyWalkProfileRef.current = applyWalkProfile;

      // 【実験的】直線距離モデル/道路網距離モデルの切り替え。"network"に初めて切り替えたときだけ
      // 44.5MBのbuilding-network-scores.jsonを遅延フェッチする（デフォルトの直線距離モデルしか
      // 使わないユーザーに無駄な大容量ダウンロードをさせないため）。取得後はapplyWalkProfileと
      // 同じ要領でscoreGenerationを進めてキャッシュを無効化し、tileVisible経由の自己修復に任せる。
      async function applyDistanceModel(model: DistanceModel) {
        distanceModelRef.current = model;
        if (model === "network" && !networkScoreMap) {
          setLoadingNetworkScores(true);
          try {
            const res = await fetch(BUILDING_NETWORK_SCORES_JSON_URL);
            if (!res.ok) throw new Error(`building-network-scores.json returned ${res.status}`);
            const rows: BuildingNetworkScoreRow[] = await res.json();
            if (cancelled) return;
            networkScoreMap = new Map(rows.map((r) => [r.buildingId, r]));
          } catch (err) {
            console.warn(
              "道路網距離モデルのデータ読み込みに失敗しました。直線距離モデルのままにします。",
              err
            );
            distanceModelRef.current = "straight";
            setDistanceModel("straight");
            setLoadingNetworkScores(false);
            return;
          }
          setLoadingNetworkScores(false);
        }
        scoreGeneration++;
        buildingScoreCache.clear();
        scoredCoveredCount = 0;
        scoredTotalCount = 0;
        setCoverageStats({ covered: 0, total: 0 });
        scheduleDemandTransitRecompute();
      }
      applyDistanceModelRef.current = (model) => {
        void applyDistanceModel(model);
      };

      // Cesium標準のクリック選択（selectionIndicator/infoBox）は無効化しているため、
      // バス停・建物クリック時の情報表示は自前のInfoPopupで行う。
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
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
            const requestId = ++demandTransitRequestId;
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
                if (cancelled || requestId !== demandTransitRequestId) return;
                areaNameText = data.areaName ?? "不明";
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              } catch (err) {
                console.warn("デマンド交通乗り場候補の地区名取得に失敗しました", err);
                if (cancelled || requestId !== demandTransitRequestId) return;
                areaNameText = "取得できませんでした";
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              }
            })();

            // 実効距離の再計算（既存の傾斜込みアクセシビリティ計算と同じロジックを、
            // 目的地だけ「クリックされた候補地点」に差し替えて呼び出す）。
            void (async () => {
              try {
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
                if (cancelled || requestId !== demandTransitRequestId) return;
                const avgNewDistance =
                  results.reduce((sum, r) => sum + r.effectiveDistanceMeters, 0) / results.length;
                newDistanceLine = `新設した場合の推定実効距離: 約${Math.round(avgNewDistance)}m`;
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              } catch (err) {
                console.warn("デマンド交通乗り場候補の再計算に失敗しました", err);
                if (cancelled || requestId !== demandTransitRequestId) return;
                newDistanceLine = "新設した場合の推定実効距離: 計算に失敗しました";
                setPopup({ title: "デマンド交通 乗り場候補", lines: buildLines() });
              }
            })();
          }
        } else if (entity instanceof Cesium.Entity && entity.properties?.isExistingDemandTransit?.getValue()) {
          const service: ExistingDemandTransitService = entity.properties.service.getValue();
          setPopup({
            title: service.name,
            lines: [
              `種別: ${service.type}`,
              `事業者: ${service.operator}`,
              `運行開始: ${service.startDate}`,
              service.description,
              ...(service.areaConfidence === "low" ? ["（円の範囲は目安。正確な運行区域とは異なる）"] : []),
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

      // カメラはバス停群の重心付近、固定半径（INITIAL_VIEW_RADIUS_METERS）に自動フィットする。
      // viewer.flyTo(entities, ...)は地形解決待ちでハングすることがあるため使わず
      // （plateau-pocで発覚した問題の再発防止）、生の頂点座標からBoundingSphereを自前計算して
      // flyToBoundingSphereで移動する。バス停全件（南北東西とも十数km）を収める広域フィットだと
      // 建物1棟が数ピクセルしかなく色分けがほぼ見えないため、重心を中心にした固定半径にしている。
      if (busStopPositions.length > 0) {
        const centroid = Cesium.BoundingSphere.fromPoints(busStopPositions).center;
        const sphere = new Cesium.BoundingSphere(centroid, INITIAL_VIEW_RADIUS_METERS);
        viewer.camera.flyToBoundingSphere(sphere, {
          offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(-30)),
        });
      }
    }

    init();

    return () => {
      cancelled = true;
      scheduleDemandTransitRecomputeRef.current = null;
      applyWalkProfileRef.current = null;
      applyDistanceModelRef.current = null;
      helloCyclingEntitiesRef.current = [];
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <Legend
        gapThreshold={demandTransitGapThreshold}
        clusterCount={demandTransitClusterCount}
        showHelloCycling={showHelloCycling}
        walkProfile={walkProfile}
        distanceModel={distanceModel}
        loadingNetworkScores={loadingNetworkScores}
        onGapThresholdChange={(value) => {
          setDemandTransitGapThreshold(value);
          scheduleDemandTransitRecomputeRef.current?.();
        }}
        onClusterCountChange={(value) => {
          setDemandTransitClusterCount(value);
          scheduleDemandTransitRecomputeRef.current?.();
        }}
        onShowHelloCyclingChange={setShowHelloCycling}
        onWalkProfileChange={(value) => {
          setWalkProfile(value);
          applyWalkProfileRef.current?.(value);
        }}
        onDistanceModelChange={(value) => {
          setDistanceModel(value);
          applyDistanceModelRef.current?.(value);
        }}
      />
      <UncoloredBuildingsNote />
      <CoverageStatsPanel covered={coverageStats.covered} total={coverageStats.total} />
      {popup && <InfoPopup info={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}
