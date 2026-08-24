"""
道路ネットワーク距離ベースの実効距離・カバー率を、住宅系建物ごとに計算する本体スクリプト。

処理の流れ:
1. 建物（01の出力）・バス停（既存public/data/bus-stops.json、主要事業者のみ）・
   鉄道駅（既存public/data/train-stations.json）・道路網（02の出力）を読み込む
2. 建物・バス停・駅をそれぞれ最寄りの道路網ノードにスナップする（ox.distance.nearest_nodes）
   - 【簡略化した点】道路"エッジ"への投影ではなく、最寄り"ノード"へのスナップにしている。
     このエリアの道路網はノード密度が高い（55,849ノード、平均間隔約50m）ため、エッジ投影との
     差は実用上小さいと判断した。建物・停留所の実座標とスナップ先ノード座標との間の直線距離
     （「道路からの最後の直線区間」）は別途加算するので、「スナップ」自体の意味は保たれている。
3. バス停用・駅用それぞれに仮想スーパーソースノードを追加し（各停留所のスナップ先ノードへ
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
import sys
import time
from pathlib import Path

import networkx as nx
import osmnx as ox

sys.path.insert(0, str(Path(__file__).parent))
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

import math


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


def build_supersource_routes(G_undirected, snap_nodes_with_names):
    """
    snap_nodes_with_names: [(name, node_id, actual_lat, actual_lng), ...]
    同じnodeに複数の停留所がスナップしている場合、実座標との最後の直線区間が最小のものを
    「その経由ノードでの代表停留所」として選ぶ。
    戻り値: (合成グラフ, スーパーソースID, node -> (name, lastMileM, lat, lng) の代表停留所辞書)

    【重要】(name, lastMileM)に加えて停留所の実座標(lat, lng)もここで直接保持しておく。
    「住宅前」のように同名の停留所が藤沢市内に複数（離れた場所に）存在するため、後段で
    停留所名から元データを引き直すと誤った（同名だが全く別の場所の）停留所の座標を
    拾ってしまい、実効距離が桁違いに跳ね上がるバグを実際に踏んだ（デバッグ時に発見）。
    """
    node_to_best = {}
    for name, node, lat, lng in snap_nodes_with_names:
        node_lat, node_lng = G_undirected.nodes[node]["y"], G_undirected.nodes[node]["x"]
        last_mile = haversine_m(lat, lng, node_lat, node_lng)
        cur = node_to_best.get(node)
        if cur is None or last_mile < cur[1]:
            node_to_best[node] = (name, last_mile, lat, lng)

    H = nx.MultiGraph(G_undirected)
    super_id = "__SUPER__"
    H.add_node(super_id, y=None, x=None)
    for node in node_to_best:
        H.add_edge(super_id, node, length=0.0)
    return H, super_id, node_to_best


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
    print(f"  建物 {len(buildings)} 件 / バス停(主要事業者) {len(bus_stops)} 件 / 駅 {len(stations)} 件", file=sys.stderr)

    G = ox.load_graphml(ROAD_NETWORK_GRAPHML)
    G_undirected = G.to_undirected()
    print(f"  道路網: {len(G_undirected.nodes)} ノード / {len(G_undirected.edges)} エッジ", file=sys.stderr)

    print("スナップ中...", file=sys.stderr)
    building_xs = [b["lng"] for b in buildings]
    building_ys = [b["lat"] for b in buildings]
    building_nodes = ox.distance.nearest_nodes(G_undirected, building_xs, building_ys)

    bus_xs = [s["lng"] for s in bus_stops]
    bus_ys = [s["lat"] for s in bus_stops]
    bus_nodes = ox.distance.nearest_nodes(G_undirected, bus_xs, bus_ys)

    station_xs = [s["lng"] for s in stations]
    station_ys = [s["lat"] for s in stations]
    station_nodes = ox.distance.nearest_nodes(G_undirected, station_xs, station_ys)

    print("バス停・駅それぞれのスーパーソースからダイクストラ実行中...", file=sys.stderr)
    bus_snap = [(s["name"], n, s["lat"], s["lng"]) for s, n in zip(bus_stops, bus_nodes)]
    station_snap = [(s["name"], n, s["lat"], s["lng"]) for s, n in zip(stations, station_nodes)]

    H_bus, super_bus, bus_node_best = build_supersource_routes(G_undirected, bus_snap)
    bus_dist, bus_paths = nx.single_source_dijkstra(H_bus, super_bus, weight="length")

    H_station, super_station, station_node_best = build_supersource_routes(G_undirected, station_snap)
    station_dist, station_paths = nx.single_source_dijkstra(H_station, super_station, weight="length")

    elevation = ElevationProvider()
    elev_cache: dict[tuple[float, float], float | None] = {}

    def get_elev(lat, lng):
        key = (round(lat, 6), round(lng, 6))
        if key not in elev_cache:
            elev_cache[key] = elevation.get_elevation(lat, lng)
        return elev_cache[key]

    def compute_side(building, building_node, dist_map, paths_map, node_best):
        if building_node not in dist_map:
            return None
        network_dist = dist_map[building_node]
        path = paths_map[building_node][1:]  # スーパーソースを除く（先頭が停留所側スナップノード）
        entry_node = path[0]
        # node_bestは(name, lastMileM, lat, lng)を保持しているので、停留所の実座標を
        # 名前での再検索なしに直接取得できる（同名停留所の取り違えバグの再発防止）。
        name, entry_last_mile, stop_lat, stop_lng = node_best[entry_node]

        node_coords = [(G_undirected.nodes[n]["y"], G_undirected.nodes[n]["x"]) for n in path]
        stop_elev = get_elev(stop_lat, stop_lng)
        building_elev = get_elev(building["lat"], building["lng"])
        node_elevs = [get_elev(lat, lng) for lat, lng in node_coords]

        # 実際の停留所座標 -> 経路上の各ノード -> 実際の建物座標、の順の頂点列。
        coords = [(stop_lat, stop_lng)] + node_coords + [(building["lat"], building["lng"])]
        elevs = [stop_elev] + node_elevs + [building_elev]

        return {
            "name": name,
            "networkDistanceM": network_dist,
            "straightLastMileM": entry_last_mile,
            "coords": coords,
            "elevs": elevs,
        }

    results = []
    n = len(buildings)
    t_compute = time.time()
    for i, building in enumerate(buildings):
        b_node = building_nodes[i]

        bus_side = compute_side(building, b_node, bus_dist, bus_paths, bus_node_best)
        station_side = compute_side(building, b_node, station_dist, station_paths, station_node_best)
        if bus_side is None or station_side is None:
            continue

        row = {
            "buildingId": building["buildingId"],
            "lat": building["lat"],
            "lng": building["lng"],
            "usage": building["usage"],
            "totalFloorArea": building["totalFloorArea"],
            "nearestStopName": bus_side["name"],
            "busNetworkDistanceM": round(bus_side["networkDistanceM"] + bus_side["straightLastMileM"], 1),
            "nearestStationName": station_side["name"],
            "stationNetworkDistanceM": round(
                station_side["networkDistanceM"] + station_side["straightLastMileM"], 1
            ),
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
