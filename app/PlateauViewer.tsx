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

// バス停データ（藤沢市北部、JR東海道線より北側のみ）。
// 神奈川中央交通のGTFS-JPは「公共交通オープンデータチャレンジ2026」限定ライセンスの
// APIキーが必要で、そのチャレンジの申込期間（2026年10月1日〜）がまだ開始していないため、
// 代わりにOpenStreetMap（Overpass API、highway=bus_stop等）から抽出したデータを暫定的に使っている。
// 事業者名の付いていないノードも多いため`operator`を絶対視せず、エリア内の全バス停として扱う。
// 10月以降にGTFS-JPの正式データが取得できるようになったら差し替える想定（詳細はAGENTS.md参照）。
const BUS_STOPS_JSON_URL = "/data/bus-stops.json";

const BUS_STOP_COLOR = Cesium.Color.fromCssColorString("#f59e0b");
const BUS_STOP_PIXEL_SIZE = 10;
// operatorタグが無い/その他事業者のバス停は参考表示として残しつつ、視覚的に控えめにする
// （下記MAJOR_OPERATOR_KEYWORDSに一致する主要事業者のみが実効距離の計算対象になるため、
// 「どのピンが計算に使われているか」が見た目で分かるようにする）。
// 当初は同じ#f59e0bを透明度35%にして小さく表示していたが、Cesiumのpointは背景（建物の色・
// 地表色）と実際に合成されるため、赤い建物の上では暗く沈み、白い建物の上では薄く白っぽく、
// 何もない地表（ortho画像未読み込み/欠損時のフォールバック色）の上では灰色がかって見えるなど、
// 背景次第で色がバラついて見える問題があった（国土数値情報P11との突き合わせで、operatorタグの
// 無い停留所の大半が実際には神奈中である可能性が高いと分かったこともあり、紛らわしい見た目を
// 放置する理由がなくなった）。→ 不透明な淡いアンバー色に変更し、背景に関わらず一定の見た目になる
// ようにした。主要事業者と同じサイズにしつつ、色相は保って「同じ系統だが未確認」と分かるようにしている。
const BUS_STOP_COLOR_MINOR = Cesium.Color.fromCssColorString("#fde68a");
const BUS_STOP_PIXEL_SIZE_MINOR = BUS_STOP_PIXEL_SIZE;

// 初期カメラの表示範囲（バス停群の重心を中心とした固定半径）。バス停653件全体（南北東西とも
// 十数km）にフィットさせると、建物1棟が画面上で数ピクセルしかなく色分けがほぼ見えない状態に
// なっていた。全件を収める代わりに、重心付近の一定範囲だけを最初から映すことで、開いた直後から
// 色分けされた建物がある程度画面いっぱいに見えるようにする（残りのエリアはズームアウト/パンして
// 確認する）。
const INITIAL_VIEW_RADIUS_METERS = 900;

// 実効距離（アクセシビリティスコア）の計算に使う「主要事業者」の判定キーワード。
// バス停データ653件のうちoperatorタグが付いているのは72件のみで、残り581件は
// タグ無し（神奈中の停留所も含まれている可能性が高いが、OSM側のタグ付けが不完全なため
// 判別できない）。operatorタグ無しを「対象外」として扱うと本来は空白地でない場所を
// 空白地と誤判定するリスクがあるが、そのリスクを許容してでも「交通空白地」というテーマに
// 対して意味のあるコントラスト（橙色・赤の分布）を出すことを優先した判断。
// タグの表記ゆれ（神奈川中央交通/神奈中/ローマ字）に対応するため部分一致で判定する。
const MAJOR_OPERATOR_KEYWORDS = ["神奈川中央交通", "神奈中", "kanatyu"];
function isMajorOperatorStop(stop: BusStop): boolean {
  if (!stop.operator) return false;
  return MAJOR_OPERATOR_KEYWORDS.some((keyword) => stop.operator!.includes(keyword));
}

type BusStop = { name: string; lat: number; lng: number; operator?: string | null };

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
// 勾配(標高差/区間距離)1あたり実効距離を何倍割り増しするかの係数。例: 勾配0.1(10%)なら
// SLOPE_PENALTY_FACTOR=3で実効距離が1.3倍になる。シンプルな線形モデルで十分という要件に基づく。
const SLOPE_PENALTY_FACTOR = 3;
// 地形データのノイズで極端な勾配が出た場合の上限（40%勾配で頭打ち）。
const SLOPE_GRADIENT_CAP = 0.4;
// 徒歩速度の目安（分速67m ≒ 時速4km）。実効距離から推定歩行時間を出すのに使う。
const WALK_SPEED_M_PER_MIN = 67;

// 津波浸水深の色分け（plateau-poc の FLOOD_RANKS）と同じ考え方で、実効距離を5段階に色分けする。
const ACCESSIBILITY_RANKS: { maxMeters: number; legendLabel: string; color: Cesium.Color }[] = [
  { maxMeters: 300, legendLabel: "〜300m", color: Cesium.Color.fromCssColorString("#22c55e") },
  { maxMeters: 600, legendLabel: "300〜600m", color: Cesium.Color.fromCssColorString("#a3e635") },
  { maxMeters: 1000, legendLabel: "600m〜1km", color: Cesium.Color.fromCssColorString("#f59e0b") },
  { maxMeters: 1500, legendLabel: "1〜1.5km", color: Cesium.Color.fromCssColorString("#f97316") },
  { maxMeters: Infinity, legendLabel: "1.5km〜", color: Cesium.Color.fromCssColorString("#dc2626") },
];

function colorForEffectiveDistance(distanceMeters: number): Cesium.Color {
  const rank =
    ACCESSIBILITY_RANKS.find((r) => distanceMeters <= r.maxMeters) ??
    ACCESSIBILITY_RANKS[ACCESSIBILITY_RANKS.length - 1];
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
  straightDistanceMeters: number;
  effectiveDistanceMeters: number;
  walkMinutes: number;
  totalFloorArea: number | null;
};

// 2点間の傾斜込み実効距離を計算する共通ロジック。住宅系建物の色分け（最寄りバス停まで）と、
// デマンド交通乗り場候補の「もしここに乗り場を新設したら」の再計算の両方で使う
// （後者は単に目的地を既存バス停群からクラスタ重心に差し替えて同じ関数を呼ぶだけでよい）。
type EffectiveDistancePair = { originLat: number; originLng: number; destLat: number; destLng: number };
type EffectiveDistanceResult = { straightDistanceMeters: number; effectiveDistanceMeters: number };

async function computeEffectiveDistances(
  terrainProvider: Cesium.TerrainProvider,
  pairs: EffectiveDistancePair[]
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
      effectiveDistanceMeters += segmentDistance * (1 + SLOPE_PENALTY_FACTOR * gradient);
    }
    return { straightDistanceMeters, effectiveDistanceMeters };
  });
}

// デマンド交通乗り場候補: アクセシビリティスコアが悪い（実効距離がACCESSIBILITY_RANKSの
// 「600m〜1km」以上）の住宅系建物の座標にk-meansクラスタリングをかけ、クラスタ重心を
// 「新しい乗り場を置くならここ」の候補地点として提案する。
const DEMAND_TRANSIT_GAP_THRESHOLD_METERS = 600;
const DEMAND_TRANSIT_CLUSTER_COUNT = 4;
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

function Legend() {
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
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 4 }}>徒歩アクセシビリティ（住宅系建物）</div>
      <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
        最寄りバス停（主要事業者のみ）までの実効距離（傾斜考慮）
      </div>
      {ACCESSIBILITY_RANKS.map((rank) => (
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
        <span>バス停（その他・事業者不明。参考表示のみ）</span>
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
        <span>デマンド交通 乗り場候補</span>
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

export default function PlateauViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [popup, setPopup] = useState<PopupInfo | null>(null);

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
      // （653件と数が多く、常時ラベル表示すると密集地でズームアウト時に重なりすぎるため）。
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
            properties: { isBusStop: true, operator: stop.operator ?? null, isMajorOperator: isMajor },
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

      // 住宅系建物ごとに「最寄りバス停までの傾斜込み実効距離」を計算し、3D Tilesの
      // フィーチャーを直接色分けする。buildingScoreCache は建物ID(_x,_yから作る代替IDを含む)
      // をキーに永続化し、タイルがアンロード→再ロードされて新しいCesium3DTileFeatureインスタンスに
      // なった場合でも地形サンプリングをやり直さずに再着色できるようにする。featureScoreMapは
      // クリック時に「今画面にある生きたfeatureオブジェクト」からスコア情報を引くためのWeakMap。
      type CachedScore = { color: Cesium.Color; info: BuildingScoreInfo };
      const buildingScoreCache = new Map<string, CachedScore>();
      const featureScoreMap = new WeakMap<Cesium.Cesium3DTileFeature, BuildingScoreInfo>();

      // デマンド交通乗り場候補（k-meansのクラスタ重心）を紫の四角ピンで表示する。
      // 建物のスコア計算が進むたびに（buildingScoreCacheが更新されるたびに）再クラスタリングする
      // 必要があるため、候補ピンの実体（Entity）とクラスタ内訳（members）を紐付けて保持しておく
      // （クリック時に「対象建物数」「現状の平均実効距離」を即座に表示するため）。
      type DemandTransitMember = { lat: number; lng: number; effectiveDistanceMeters: number };
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
          if (info.effectiveDistanceMeters > DEMAND_TRANSIT_GAP_THRESHOLD_METERS) {
            gapBuildings.push({ lat: info.lat, lng: info.lng, effectiveDistanceMeters: info.effectiveDistanceMeters });
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
        const clusters = kMeans(projected, DEMAND_TRANSIT_CLUSTER_COUNT);

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

      async function processTile(tile: Cesium.Cesium3DTile) {
        if (tokaidoLinePoints.length === 0 || majorOperatorStopList.length === 0) return;
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

        // 各建物の最寄りバス停を探す。主要事業者のバス停のみを対象にする
        // （理由は上のMAJOR_OPERATOR_KEYWORDSのコメント参照）。件数は少ないため総当たりで十分速い。
        const withNearest = candidates.map((c) => {
          let bestStop: BusStop | null = null;
          let bestDist = Infinity;
          for (const stop of majorOperatorStopList) {
            const d = haversineMeters(c.lat, c.lng, stop.lat, stop.lng);
            if (d < bestDist) {
              bestDist = d;
              bestStop = stop;
            }
          }
          return { ...c, nearestStop: bestStop as BusStop };
        });

        let results: EffectiveDistanceResult[];
        try {
          results = await computeEffectiveDistances(
            terrainProvider,
            withNearest.map((c) => ({
              originLat: c.lat,
              originLng: c.lng,
              destLat: c.nearestStop.lat,
              destLng: c.nearestStop.lng,
            }))
          );
        } catch (err) {
          console.warn(
            "傾斜計算用の地形サンプリングに失敗しました。このタイルの建物群はスコア計算をスキップします。",
            err
          );
          return;
        }
        if (cancelled) return;

        withNearest.forEach((c, idx) => {
          const { straightDistanceMeters, effectiveDistanceMeters } = results[idx];
          const walkMinutes = effectiveDistanceMeters / WALK_SPEED_M_PER_MIN;
          const color = colorForEffectiveDistance(effectiveDistanceMeters);
          const info: BuildingScoreInfo = {
            usage: c.usage,
            lat: c.lat,
            lng: c.lng,
            nearestStopName: c.nearestStop.name,
            straightDistanceMeters,
            effectiveDistanceMeters,
            walkMinutes,
            totalFloorArea: c.totalFloorArea,
          };
          c.feature.color = color;
          buildingScoreCache.set(c.buildingId, { color, info });
          featureScoreMap.set(c.feature, info);
        });

        scheduleDemandTransitRecompute();
      }

      tileset?.tileLoad.addEventListener((tile: Cesium.Cesium3DTile) => {
        void processTile(tile);
      });

      // Cesium標準のクリック選択（selectionIndicator/infoBox）は無効化しているため、
      // バス停・建物クリック時の情報表示は自前のInfoPopupで行う。
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        const picked = viewer.scene.pick(movement.position);
        const entity = picked?.id;
        if (entity instanceof Cesium.Entity && entity.properties?.isBusStop?.getValue()) {
          const operator = entity.properties.operator?.getValue();
          setPopup({
            title: entity.name ?? "バス停",
            lines: operator ? [`事業者: ${operator}`] : ["事業者情報なし（OSMデータ）"],
          });
        } else if (entity instanceof Cesium.Entity && entity.properties?.isDemandTransitCandidate?.getValue()) {
          const candidate = demandTransitCandidates.find((c) => c.entity === entity);
          if (!candidate) {
            setPopup(null);
          } else {
            const requestId = ++demandTransitRequestId;
            const avgCurrentDistance =
              candidate.members.reduce((sum, m) => sum + m.effectiveDistanceMeters, 0) / candidate.members.length;

            // 地区名（逆ジオコーディング）と実効距離の再計算は互いに独立した非同期処理で、
            // 完了したほうから順にポップアップへ反映する。両方の最新状態をこの2変数で保持し、
            // どちらかが完了するたびに buildLines() で組み直したポップアップを表示する。
            let areaNameText = "取得中…";
            let newDistanceLine = "新設した場合の推定実効距離: 計算中…";
            const buildLines = () => [
              `推定地区名: ${areaNameText}`,
              `対象建物数: ${candidate.members.length}棟`,
              `現状の平均実効距離: 約${Math.round(avgCurrentDistance)}m`,
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
                  }))
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
        } else if (picked instanceof Cesium.Cesium3DTileFeature) {
          const info = featureScoreMap.get(picked);
          if (info) {
            setPopup({
              title: info.usage,
              lines: [
                `最寄りバス停: ${info.nearestStopName}`,
                `直線距離: 約${Math.round(info.straightDistanceMeters)}m`,
                `実効距離（傾斜考慮）: 約${Math.round(info.effectiveDistanceMeters)}m`,
                `徒歩時間目安: 約${Math.round(info.walkMinutes)}分`,
                ...(info.totalFloorArea != null ? [`延床面積: 約${Math.round(info.totalFloorArea)}m²`] : []),
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
          offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(-30), 0),
        });
      }
    }

    init();

    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <Legend />
      <UncoloredBuildingsNote />
      {popup && <InfoPopup info={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}
