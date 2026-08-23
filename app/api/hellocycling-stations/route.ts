import { NextResponse } from "next/server";

// ODPT（公共交通オープンデータセンター）のGBFS形式データへのサーバーサイドプロキシ。
// クライアントから直接叩くとアクセストークン（ODPT_CONSUMER_KEY）がブラウザに露出してしまうため、
// /api/reverse-geocode と同じ方針でサーバー側にキーを隠蔽している。
//
// データ出典: OpenStreet株式会社（ハローサイクリング）バイクシェア関連情報（GBFS形式）
// 提供: 公共交通オープンデータセンター（ODPT）
// ライセンス: CC BY 4.0 / ODC BY 1.0 / ODbL 1.0（データカタログの記載に従う。詳細はREADME.md参照）
// コンテンツ等の提供者名: OpenStreet株式会社 / 公共交通オープンデータ協議会
const GBFS_STATION_INFO_URL = "https://api.odpt.org/api/v4/gbfs/hellocycling/station_information.json";

// このAPIは常時公開データ（GTFS-JPのような「公共交通オープンデータチャレンジ2026限定ライセンス」の
// 対象外）であり、ODPTセンターの通常アクセストークンで取得できる（バス停データの経緯はAGENTS.md参照）。
const ODPT_CONSUMER_KEY = process.env.ODPT_CONSUMER_KEY;

const ODPT_TIMEOUT_MS = 8000;

// 藤沢市北部エリアの簡易バウンディングボックス。既存のbus-stops.json（Overpass藤沢市境界＋
// isNorthOfTokaidoLineで絞り込み済み、337件）の緯度経度の範囲から算出し、多少の余裕を持たせた値。
// GBFSは全国のステーションを一括で返すため、まずこの矩形で大まかに絞り込んでから、
// 東海道線より北かどうかの判定を適用する。藤沢市の行政境界ポリゴンそのものは使っていないため、
// 隣接自治体（大和市・綾瀬市など）の一部が誤って含まれる可能性がある簡易フィルタである点に注意。
const NORTH_FUJISAWA_BBOX = { minLat: 35.32, maxLat: 35.44, minLng: 139.39, maxLng: 139.52 };

type TokaidoLinePoint = [number, number]; // [lng, lat]

// isNorthOfTokaidoLine（app/PlateauViewer.tsx）と同じロジック。サーバー側のRoute Handlerと
// クライアント側の"use client"コンポーネントをまたいだimportは避け、自己完結させている。
function lineLatAtLon(points: TokaidoLinePoint[], lon: number): number {
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
function isNorthOfTokaidoLine(points: TokaidoLinePoint[], lng: number, lat: number): boolean {
  if (points.length === 0) return false;
  return lat > lineLatAtLon(points, lng);
}

type GbfsStation = {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
  capacity?: number;
};
type GbfsStationInformation = { data?: { stations?: GbfsStation[] } };

export async function GET(request: Request) {
  if (!ODPT_CONSUMER_KEY) {
    console.error("ODPT_CONSUMER_KEY environment variable is not set");
    return NextResponse.json(
      { error: "ODPT_CONSUMER_KEY is not configured on the server" },
      { status: 500 }
    );
  }

  // isNorthOfTokaidoLineの判定用に、既存の東海道線ポリラインを同一オリジンから取得する
  // （publicディレクトリのファイルをfsで直接読むのはVercelのFunctionバンドリング仕様上
  // 確実ではないため、クライアントと同じくHTTP経由で取得する方針に統一している）。
  let tokaidoLinePoints: TokaidoLinePoint[] = [];
  try {
    const tokaidoRes = await fetch(new URL("/data/tokaido-line.json", request.url));
    const tokaidoData: { points: TokaidoLinePoint[] } = await tokaidoRes.json();
    tokaidoLinePoints = tokaidoData.points;
  } catch (err) {
    console.warn("東海道線データの読み込みに失敗しました。北部判定をスキップします", err);
  }

  const url = new URL(GBFS_STATION_INFO_URL);
  url.searchParams.set("acl:consumerKey", ODPT_CONSUMER_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ODPT_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      console.warn("ODPT GBFS station_information.jsonの取得に失敗しました", res.status, await res.text());
      return NextResponse.json({ error: "ODPT GBFS request failed" }, { status: 502 });
    }

    const data: GbfsStationInformation = await res.json();
    const allStations = data.data?.stations ?? [];

    const stations = allStations
      .filter((s) => {
        if (
          s.lat < NORTH_FUJISAWA_BBOX.minLat ||
          s.lat > NORTH_FUJISAWA_BBOX.maxLat ||
          s.lon < NORTH_FUJISAWA_BBOX.minLng ||
          s.lon > NORTH_FUJISAWA_BBOX.maxLng
        ) {
          return false;
        }
        if (tokaidoLinePoints.length > 0 && !isNorthOfTokaidoLine(tokaidoLinePoints, s.lon, s.lat)) {
          return false;
        }
        return true;
      })
      .map((s) => ({
        id: s.station_id,
        name: s.name,
        lat: s.lat,
        lng: s.lon,
        capacity: typeof s.capacity === "number" ? s.capacity : null,
      }));

    return NextResponse.json({ stations });
  } catch (err) {
    console.warn("ODPT GBFSへのリクエストに失敗しました", err);
    return NextResponse.json({ error: "ODPT GBFS request failed" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
