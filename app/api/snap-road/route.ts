import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// 道路スナップAPI:
// ユーザーが地図上でクリックした地点を、藤沢市の歩行道路ネットワーク（routing-graph.json）の
// 「本物の道路エッジ（線分）」上の最近傍点に自動吸着（スナップ）させる。
// ※建物敷地やアクセスエッジ（road === 0）は除外し、100%公道・道路（road === 1）の線分のみを対象とする。
// 道路から一定以上（デフォルト35m）離れた場所（山林・池・私有地奥など）はスナップ不可として弾く。

type RoutingGraphData = {
  nodes: [number, number, number][]; // [lng, lat, elevation]
  edges: [number, number, number, number, number, number][]; // [u, v, len, eff_gen, eff_eld, road]
};

// 空間グリッド（約500mメッシュ）による高速エッジ探索
const GRID_DEG = 0.005;
const DEFAULT_MAX_DISTANCE_METERS = 35;

type SnapSpatialIndex = {
  grid: Map<string, number[]>;
  roadEdges: [number, number][];
  nodes: [number, number, number][];
};

let cachedIndex: SnapSpatialIndex | null = null;

function ensureSpatialIndex(): SnapSpatialIndex | null {
  if (cachedIndex) {
    return cachedIndex;
  }

  try {
    const jsonPath = path.join(process.cwd(), "public", "data", "routing-graph.json");
    if (!fs.existsSync(jsonPath)) {
      console.warn("routing-graph.json not found at", jsonPath);
      return null;
    }

    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data: RoutingGraphData = JSON.parse(raw);
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      return null;
    }

    // 本物の道路エッジ（road === 1）のみを抽出
    const roadEdges: [number, number][] = [];
    for (let i = 0; i < data.edges.length; i++) {
      const e = data.edges[i];
      if (e[5] === 1) {
        roadEdges.push([e[0], e[1]]);
      }
    }

    // エッジのバウンディングボックスを空間グリッドに登録
    const grid = new Map<string, number[]>();
    for (let i = 0; i < roadEdges.length; i++) {
      const [u, v] = roadEdges[i];
      const [lng1, lat1] = data.nodes[u];
      const [lng2, lat2] = data.nodes[v];

      const minGx = Math.floor(Math.min(lng1, lng2) / GRID_DEG);
      const maxGx = Math.floor(Math.max(lng1, lng2) / GRID_DEG);
      const minGy = Math.floor(Math.min(lat1, lat2) / GRID_DEG);
      const maxGy = Math.floor(Math.max(lat1, lat2) / GRID_DEG);

      for (let gx = minGx; gx <= maxGx; gx++) {
        for (let gy = minGy; gy <= maxGy; gy++) {
          const key = `${gx}_${gy}`;
          let cell = grid.get(key);
          if (!cell) {
            cell = [];
            grid.set(key, cell);
          }
          cell.push(i);
        }
      }
    }

    cachedIndex = { grid, roadEdges, nodes: data.nodes };
    return cachedIndex;
  } catch (err) {
    console.error("Failed to load or index routing-graph.json", err);
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const latStr = searchParams.get("lat");
  const lngStr = searchParams.get("lng");
  const maxDistStr = searchParams.get("maxDistance");

  const lat = Number(latStr);
  const lng = Number(lngStr);
  const maxDistance = maxDistStr ? Number(maxDistStr) : DEFAULT_MAX_DISTANCE_METERS;

  if (!latStr || !lngStr || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng query params are required" }, { status: 400 });
  }

  const loaded = ensureSpatialIndex();
  if (!loaded) {
    return NextResponse.json({ error: "road network data is not available" }, { status: 503 });
  }

  const { grid, roadEdges, nodes } = loaded;
  const gx = Math.floor(lng / GRID_DEG);
  const gy = Math.floor(lat / GRID_DEG);
  const cosLat = Math.cos((lat * Math.PI) / 180);

  let bestDist = Infinity;
  let bestPoint: { lat: number; lng: number } | null = null;
  const checked = new Set<number>();

  // 周囲3x3セル（約1.5km四方）の道路エッジを探索し、線分への最近傍点を計算
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(`${gx + dx}_${gy + dy}`);
      if (!cell) continue;
      for (let k = 0; k < cell.length; k++) {
        const edgeIdx = cell[k];
        if (checked.has(edgeIdx)) continue;
        checked.add(edgeIdx);

        const [u, v] = roadEdges[edgeIdx];
        const [lngA, latA] = nodes[u];
        const [lngB, latB] = nodes[v];

        // クリック地点 (lat, lng) を原点としたローカルメートル座標
        const ax = (lngA - lng) * 111000 * cosLat;
        const ay = (latA - lat) * 111000;
        const bx = (lngB - lng) * 111000 * cosLat;
        const by = (latB - lat) * 111000;

        const abx = bx - ax;
        const aby = by - ay;
        const abLenSq = abx * abx + aby * aby;

        // 線分ABに対する垂線の足パラメータ t (0 <= t <= 1)
        let t = 0;
        if (abLenSq > 0) {
          t = (-ax * abx - ay * aby) / abLenSq;
          t = Math.max(0, Math.min(1, t));
        }

        const projX = ax + t * abx;
        const projY = ay + t * aby;
        const dist = Math.hypot(projX, projY);

        if (dist < bestDist) {
          bestDist = dist;
          bestPoint = {
            lng: lngA + t * (lngB - lngA),
            lat: latA + t * (latB - latA),
          };
        }
      }
    }
  }

  const snapped = bestDist <= maxDistance && bestPoint !== null;

  return NextResponse.json({
    snapped,
    distanceMeters: Number.isFinite(bestDist) ? Math.round(bestDist * 10) / 10 : null,
    maxDistanceMeters: maxDistance,
    original: { lat, lng },
    snappedTo: snapped && bestPoint ? { lat: bestPoint.lat, lng: bestPoint.lng } : null,
  });
}
