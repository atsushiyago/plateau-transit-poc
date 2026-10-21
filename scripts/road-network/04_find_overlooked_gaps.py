"""
「直線距離では公式基準を満たす(カバーされている)扱いだが、道路網距離では実は交通空白地」
という建物 = 丹野氏の言う「見落としていたニーズ」を特定する。

同じ標高データソース(GSI DEM5A)で直線距離版の実効距離・カバー率を全78,542件ぶん計算し、
既存のbuilding-network-scores.json（道路網距離版、03_compute_scores.pyの出力）と突き合わせる。

出力:
- overlooked_gaps.geojson: 「直線カバー済み→道路網空白地」に転じた建物（Point、属性に両モデルの数値）
- overlooked_gaps_summary.json: 件数・統計サマリー
"""

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from elevation import ElevationProvider  # noqa: E402

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
BUILDINGS_JSON = SCRIPT_DIR / "buildings.json"
NETWORK_SCORES_JSON = REPO_ROOT / "public" / "data" / "building-network-scores.json"
BUS_STOPS_JSON = REPO_ROOT / "public" / "data" / "analysis-facilities.json"
TRAIN_STATIONS_JSON = REPO_ROOT / "public" / "data" / "analysis-facilities.json"
OUTPUT_GEOJSON = SCRIPT_DIR / "overlooked_gaps.geojson"
OUTPUT_SUMMARY = SCRIPT_DIR / "overlooked_gaps_summary.json"

MAJOR_OPERATOR_KEYWORDS = ["神奈川中央交通"]
BUS_COVERAGE_THRESHOLD_METERS = 300
STATION_COVERAGE_THRESHOLD_METERS = 600
SLOPE_GRADIENT_CAP = 0.4
SLOPE_SAMPLE_COUNT = 5
# app/PlateauViewer.tsx の WALK_PROFILES["general"] と同じ値。
SLOPE_PENALTY_FACTOR_GENERAL = 3


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def straight_effective_distance(lat1, lng1, lat2, lng2, elevation, elev_cache):
    straight = haversine_m(lat1, lng1, lat2, lng2)
    seg_dist = straight / (SLOPE_SAMPLE_COUNT - 1)
    heights = []
    for s in range(SLOPE_SAMPLE_COUNT):
        t = s / (SLOPE_SAMPLE_COUNT - 1)
        lat = lat1 + (lat2 - lat1) * t
        lng = lng1 + (lng2 - lng1) * t
        key = (round(lat, 6), round(lng, 6))
        if key not in elev_cache:
            elev_cache[key] = elevation.get_elevation(lat, lng)
        h = elev_cache[key]
        heights.append(h if h is not None else 0.0)
    total = 0.0
    for k in range(len(heights) - 1):
        rise = abs(heights[k + 1] - heights[k])
        gradient = min(rise / max(seg_dist, 1), SLOPE_GRADIENT_CAP)
        total += seg_dist * (1 + SLOPE_PENALTY_FACTOR_GENERAL * gradient)
    return straight, total


def main():
    t0 = time.time()
    print("データ読み込み中...", file=sys.stderr)
    buildings = json.loads(BUILDINGS_JSON.read_text())
    bus_stops_all = json.loads(BUS_STOPS_JSON.read_text())["busStops"]
    bus_stops = [s for s in bus_stops_all if any(k in s["operator"] for k in MAJOR_OPERATOR_KEYWORDS)]
    stations = json.loads(TRAIN_STATIONS_JSON.read_text())["stations"]
    network_rows = {r["buildingId"]: r for r in json.loads(NETWORK_SCORES_JSON.read_text())}
    print(
        f"  建物 {len(buildings)} 件 / バス停(主要事業者) {len(bus_stops)} 件 / "
        f"駅 {len(stations)} 件 / 道路網スコア済み {len(network_rows)} 件",
        file=sys.stderr,
    )

    elevation = ElevationProvider()
    elev_cache: dict[tuple[float, float], float | None] = {}

    overlooked = []  # 直線カバー済み -> 道路網空白地（見落としていたニーズ）
    reverse_flip = []  # 逆パターン（直線空白地 -> 道路網カバー済み、参考値）
    both_covered = 0
    both_gap = 0
    skipped_no_network = 0

    n = len(buildings)
    for i, b in enumerate(buildings):
        row = network_rows.get(b["buildingId"])
        if row is None:
            skipped_no_network += 1
            continue

        best_bus = min(bus_stops, key=lambda s: haversine_m(b["lat"], b["lng"], s["lat"], s["lng"]))
        best_station = min(stations, key=lambda s: haversine_m(b["lat"], b["lng"], s["lat"], s["lng"]))

        _, bus_eff = straight_effective_distance(
            b["lat"], b["lng"], best_bus["lat"], best_bus["lng"], elevation, elev_cache
        )
        _, station_eff = straight_effective_distance(
            b["lat"], b["lng"], best_station["lat"], best_station["lng"], elevation, elev_cache
        )
        straight_ratio = min(bus_eff / BUS_COVERAGE_THRESHOLD_METERS, station_eff / STATION_COVERAGE_THRESHOLD_METERS)
        straight_covered = straight_ratio <= 1
        network_covered = row["isCovered_general"]

        if straight_covered and network_covered:
            both_covered += 1
        elif not straight_covered and not network_covered:
            both_gap += 1
        elif straight_covered and not network_covered:
            overlooked.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [b["lng"], b["lat"]]},
                    "properties": {
                        "buildingId": b["buildingId"],
                        "usage": b["usage"],
                        "totalFloorArea": b["totalFloorArea"],
                        "straightBusEffectiveM": round(bus_eff, 1),
                        "straightStationEffectiveM": round(station_eff, 1),
                        "straightCoverageRatio": round(straight_ratio, 3),
                        "networkBusEffectiveM": row["busEffectiveDistanceM_general"],
                        "networkStationEffectiveM": row["stationEffectiveDistanceM_general"],
                        "networkCoverageRatio": row["coverageRatio_general"],
                        "nearestStopNameStraight": best_bus["name"],
                        "nearestStopNameNetwork": row["nearestStopName"],
                        "nearestStationName": best_station["name"],
                    },
                }
            )
        else:
            reverse_flip.append(b["buildingId"])

        if (i + 1) % 5000 == 0 or i == n - 1:
            elapsed = time.time() - t0
            print(f"  {i + 1}/{n} 件処理済み（{(i + 1) / elapsed:.1f}件/秒、経過{elapsed:.0f}秒）", file=sys.stderr)

    geojson = {"type": "FeatureCollection", "features": overlooked}
    OUTPUT_GEOJSON.write_text(json.dumps(geojson, ensure_ascii=False))

    summary = {
        "totalBuildingsCompared": both_covered + both_gap + len(overlooked) + len(reverse_flip),
        "skippedNoNetworkScore": skipped_no_network,
        "bothCovered": both_covered,
        "bothGap": both_gap,
        "overlookedCount_straightCoveredButNetworkGap": len(overlooked),
        "reverseFlipCount_straightGapButNetworkCovered": len(reverse_flip),
    }
    OUTPUT_SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2))

    print(json.dumps(summary, ensure_ascii=False, indent=2), file=sys.stderr)
    print(f"書き出し完了: {OUTPUT_GEOJSON} ({len(overlooked)}件)", file=sys.stderr)
    print(f"総所要時間: {time.time() - t0:.1f}秒", file=sys.stderr)


if __name__ == "__main__":
    main()
