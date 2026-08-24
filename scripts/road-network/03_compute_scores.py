"""
道路ネットワーク距離ベースの実効距離・カバー率を、住宅系建物ごとに計算する本体スクリプト。

処理の流れ:
1. 建物（01の出力）・バス停（既存public/data/bus-stops.json、主要事業者のみ）・
   鉄道駅（既存public/data/train-stations.json）・道路網（02の出力）を読み込む
2. 建物・バス停・駅をそれぞれ最寄りの道路網「エッジ上の点」にスナップする（edge_snap.EdgeSnapper。
   最寄り"ノード"へのスナップだと、停留所からわずか数十mしか離れていない建物でも経路距離が
   数百m跳ね上がる問題があったため、エッジへの垂線投影＋仮想ノード挿入方式に変更した。
   詳細はREADME.md参照）
3. バス停用・駅用それぞれに仮想スーパーソースノードを追加し（各停留所の仮想スナップノードへ
   重み0のエッジを張る）、そこから1回のダイクストラ法で全ノードへの最短経路距離・経路を一括計算する
   （建物ごとに逐一「最寄りのバス停」を直線距離で決め打ちしてから経路探索するのではなく、
   ネットワーク上で本当に最も近い停留所を見つけるのが目的）
4. 各建物について、経路上の各ノード＋建物・停留所の実座標を頂点列とし、区間ごとに国土地理院
   DEM5Aタイルから標高を取得して勾配を求め、既存アプリ（app/PlateauViewer.tsxの
   computeEffectiveDistances）と全く同じ計算式（区間距離×(1+係数×min(勾配,0.4))）で
   実効距離を積み上げる。係数は「一般」（3）「高齢者」（6）の両方で計算し、既存の
   プロファイル切り替え機能をそのまま維持できるようにする
5. カバー率 = min(バス実効距離/300, 駅実効距離/600) を算出し、最終的にbuilding-network-scores.json
   （public/data/）に書き出す
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

import networkx as nx
import osmnx as ox

sys.path.insert(0, str(Path(__file__).parent))
from edge_snap import EdgeSnapper  # noqa: E402
from elevation import ElevationProvider  # noqa: E402

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
BUILDINGS_JSON = SCRIPT_DIR / "buildings.json"
ROAD_NETWORK_GRAPHML = SCRIPT_DIR / "road_network.graphml"
BUS_STOPS_JSON = REPO_ROOT / "public" / "data" / "bus-stops.json"
TRAIN_STATIONS_JSON = REPO_ROOT / "public" / "data" / "train-stations.json"
OUTPUT_JSON = REPO_ROOT / "public" / "data" / "building-network-scores.json"

MAJOR_OPERATOR_KEYWORDS = ["神奈川中央交通"]
BUS_COVERAGE_THRESHOLD_METERS = 300
STATION_COVERAGE_THRESHOLD_METERS = 600
SLOPE_GRADIENT_CAP = 0.4
# app/PlateauViewer.tsx の WALK_PROFILES と同じ値
WALK_PROFILES = {
    "general": {"slopePenaltyFactor": 3, "walkSpeedMPerMin": 67},
    "elderly": {"slopePenaltyFactor": 6, "walkSpeedMPerMin": 50},
}


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def effective_distance(coords, elevations, slope_penalty_factor):
    """coords: [(lat,lng), ...]の頂点列。elevations: 対応する標高（Noneがあれば0扱い）。"""
    total = 0.0
    for i in range(len(coords) - 1):
        lat1, lng1 = coords[i]
        lat2, lng2 = coords[i + 1]
        seg_dist = haversine_m(lat1, lng1, lat2, lng2)
        e1 = elevations[i] if elevations[i] is not None else 0.0
        e2 = elevations[i + 1] if elevations[i + 1] is not None else 0.0
        rise = abs(e2 - e1)
        gradient = min(rise / max(seg_dist, 1), SLOPE_GRADIENT_CAP)
        total += seg_dist * (1 + slope_penalty_factor * gradient)
    return total


def insert_virtual_nodes(G, snapper, points, id_prefix):
    """
    points: [(lat, lng), ...]
    各点をedge_snap.EdgeSnapperでエッジ上にスナップし、Gに仮想ノードとして挿入する
    （u・vそれぞれへ按分した距離のエッジを張るだけで、元のu-vエッジはそのまま残す。
    按分の合計が元のエッジ長と一致するため、これはショートカットにならない）。
    戻り値: [(virtual_id, snap_lat, snap_lng, perp_dist_m), ...]（pointsと同じ順序）
    """
    lats = [p[0] for p in points]
    lngs = [p[1] for p in points]
    snapped = snapper.snap_batch(lats, lngs)

    out = []
    for i, (u, v, key, snap_lat, snap_lng, dist_to_u, dist_to_v, perp) in enumerate(snapped):
        vid = f"{id_prefix}{i}"
        G.add_node(vid, y=snap_lat, x=snap_lng)
        G.add_edge(vid, u, length=dist_to_u)
        G.add_edge(vid, v, length=dist_to_v)
        out.append((vid, snap_lat, snap_lng, perp))
    return out


def run_supersource_dijkstra(G, virtual_ids):
    """Gに一時的にスーパーソースを追加し、virtual_idsへの重み0エッジを張ってダイクストラを実行、
    完了後はスーパーソースを取り除く（Gをグローバルに使い回すため、後続の駅側計算に影響しないよう
    後始末する）。"""
    super_id = "__SUPER__"
    G.add_node(super_id)
    for vid in virtual_ids:
        G.add_edge(super_id, vid, length=0.0)
    dist, paths = nx.single_source_dijkstra(G, super_id, weight="length")
    G.remove_node(super_id)
    return dist, paths


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="デバッグ用: 建物数を先頭N件に制限")
    parser.add_argument("--buildings-file", type=str, default=None, help="建物一覧JSONのパスを差し替える")
    parser.add_argument("--output", type=str, default=None, help="出力先パスを差し替える")
    args = parser.parse_args()

    t0 = time.time()
    print("データ読み込み中...", file=sys.stderr)
    buildings_path = Path(args.buildings_file) if args.buildings_file else BUILDINGS_JSON
    buildings = json.loads(buildings_path.read_text())
    if args.limit:
        buildings = buildings[: args.limit]
    bus_stops_all = json.loads(BUS_STOPS_JSON.read_text())["busStops"]
    bus_stops = [s for s in bus_stops_all if any(k in s["operator"] for k in MAJOR_OPERATOR_KEYWORDS)]
    stations = json.loads(TRAIN_STATIONS_JSON.read_text())["stations"]
    print(
        f"  建物 {len(buildings)} 件 / バス停(主要事業者) {len(bus_stops)} 件 / 駅 {len(stations)} 件",
        file=sys.stderr,
    )

    G = ox.load_graphml(ROAD_NETWORK_GRAPHML)
    G_undirected = G.to_undirected()
    print(f"  道路網: {len(G_undirected.nodes)} ノード / {len(G_undirected.edges)} エッジ", file=sys.stderr)

    print("エッジスナップ用の投影グラフを構築中...", file=sys.stderr)
    snapper = EdgeSnapper(G_undirected)

    print("建物・バス停・駅をエッジ上にスナップして仮想ノードを挿入中...", file=sys.stderr)
    building_virtual = insert_virtual_nodes(
        G_undirected, snapper, [(b["lat"], b["lng"]) for b in buildings], "bldg::"
    )
    bus_virtual = insert_virtual_nodes(
        G_undirected, snapper, [(s["lat"], s["lng"]) for s in bus_stops], "bus::"
    )
    station_virtual = insert_virtual_nodes(
        G_undirected, snapper, [(s["lat"], s["lng"]) for s in stations], "sta::"
    )
    print(
        f"  道路網（仮想ノード挿入後）: {len(G_undirected.nodes)} ノード / {len(G_undirected.edges)} エッジ",
        file=sys.stderr,
    )

    print("バス停・駅それぞれのスーパーソースからダイクストラ実行中...", file=sys.stderr)
    bus_vids = [v[0] for v in bus_virtual]
    bus_dist, bus_paths = run_supersource_dijkstra(G_undirected, bus_vids)

    station_vids = [v[0] for v in station_virtual]
    station_dist, station_paths = run_supersource_dijkstra(G_undirected, station_vids)

    # virtual_id -> (name/info, snap_lat, snap_lng, perp_dist, actual_lat, actual_lng)
    bus_info = {
        vid: (bus_stops[i]["name"], snap_lat, snap_lng, perp, bus_stops[i]["lat"], bus_stops[i]["lng"])
        for i, (vid, snap_lat, snap_lng, perp) in enumerate(bus_virtual)
    }
    station_info = {
        vid: (stations[i]["name"], snap_lat, snap_lng, perp, stations[i]["lat"], stations[i]["lng"])
        for i, (vid, snap_lat, snap_lng, perp) in enumerate(station_virtual)
    }

    elevation = ElevationProvider()
    elev_cache: dict[tuple[float, float], float | None] = {}

    def get_elev(lat, lng):
        key = (round(lat, 6), round(lng, 6))
        if key not in elev_cache:
            elev_cache[key] = elevation.get_elevation(lat, lng)
        return elev_cache[key]

    def compute_side(building, building_vid, building_perp, dist_map, paths_map, info_map):
        if building_vid not in dist_map:
            return None
        network_dist = dist_map[building_vid]
        path = paths_map[building_vid][1:]  # スーパーソースを除く（先頭が停留所側の仮想ノード）
        entry_vid = path[0]
        name, stop_snap_lat, stop_snap_lng, stop_perp, stop_lat, stop_lng = info_map[entry_vid]

        # path[0]=停留所の仮想スナップノード, path[-1]=建物の仮想スナップノード。
        # 実座標 -> 仮想スナップノード -> 経路上の実ノード群 -> 仮想スナップノード -> 実座標、の順。
        node_coords = [
            (G_undirected.nodes[n]["y"], G_undirected.nodes[n]["x"]) for n in path
        ]
        coords = [(stop_lat, stop_lng)] + node_coords + [(building["lat"], building["lng"])]
        elevs = [get_elev(stop_lat, stop_lng)] + [get_elev(lat, lng) for lat, lng in node_coords] + [
            get_elev(building["lat"], building["lng"])
        ]

        return {
            "name": name,
            "totalDistanceM": network_dist + stop_perp + building_perp,
            "coords": coords,
            "elevs": elevs,
        }

    results = []
    n = len(buildings)
    t_compute = time.time()
    for i, building in enumerate(buildings):
        b_vid, _, _, b_perp = building_virtual[i]

        bus_side = compute_side(building, b_vid, b_perp, bus_dist, bus_paths, bus_info)
        station_side = compute_side(building, b_vid, b_perp, station_dist, station_paths, station_info)
        if bus_side is None or station_side is None:
            continue

        row = {
            "buildingId": building["buildingId"],
            "lat": building["lat"],
            "lng": building["lng"],
            "usage": building["usage"],
            "totalFloorArea": building["totalFloorArea"],
            "nearestStopName": bus_side["name"],
            "busNetworkDistanceM": round(bus_side["totalDistanceM"], 1),
            "nearestStationName": station_side["name"],
            "stationNetworkDistanceM": round(station_side["totalDistanceM"], 1),
        }
        for profile_key, profile in WALK_PROFILES.items():
            bus_eff = effective_distance(bus_side["coords"], bus_side["elevs"], profile["slopePenaltyFactor"])
            station_eff = effective_distance(
                station_side["coords"], station_side["elevs"], profile["slopePenaltyFactor"]
            )
            coverage_ratio = min(
                bus_eff / BUS_COVERAGE_THRESHOLD_METERS, station_eff / STATION_COVERAGE_THRESHOLD_METERS
            )
            row[f"busEffectiveDistanceM_{profile_key}"] = round(bus_eff, 1)
            row[f"stationEffectiveDistanceM_{profile_key}"] = round(station_eff, 1)
            row[f"coverageRatio_{profile_key}"] = round(coverage_ratio, 4)
            row[f"isCovered_{profile_key}"] = coverage_ratio <= 1

        results.append(row)

        if (i + 1) % 2000 == 0 or i == n - 1:
            elapsed = time.time() - t_compute
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            print(f"  {i + 1}/{n} 件処理済み（{rate:.1f}件/秒）", file=sys.stderr)

    output_path = Path(args.output) if args.output else OUTPUT_JSON
    output_path.write_text(json.dumps(results, ensure_ascii=False))
    print(f"書き出し完了: {output_path} ({len(results)} 件)", file=sys.stderr)
    print(f"総所要時間: {time.time() - t0:.1f}秒", file=sys.stderr)

    covered_general = sum(1 for r in results if r["isCovered_general"])
    covered_elderly = sum(1 for r in results if r["isCovered_elderly"])
    print(
        f"建物カバー率（一般）: {covered_general}/{len(results)} = {covered_general / len(results) * 100:.1f}%",
        file=sys.stderr,
    )
    print(
        f"建物カバー率（高齢者）: {covered_elderly}/{len(results)} = {covered_elderly / len(results) * 100:.1f}%",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
