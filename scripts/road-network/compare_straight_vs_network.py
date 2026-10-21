"""
同じ300件サンプル・同じ標高データソース(GSI DEM5A)で、直線距離ベースと道路網距離ベースの
実効距離・カバー率を比較する（違いが「経路の違い」由来なのか切り分けるための検証スクリプト）。
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from elevation import ElevationProvider  # noqa: E402

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
BUS_STOPS_JSON = REPO_ROOT / "public" / "data" / "analysis-facilities.json"
TRAIN_STATIONS_JSON = REPO_ROOT / "public" / "data" / "analysis-facilities.json"

MAJOR_OPERATOR_KEYWORDS = ["神奈川中央交通"]
BUS_COVERAGE_THRESHOLD_METERS = 300
STATION_COVERAGE_THRESHOLD_METERS = 600
SLOPE_GRADIENT_CAP = 0.4
SLOPE_PENALTY_FACTOR_GENERAL = 3
SLOPE_SAMPLE_COUNT = 5


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def straight_effective_distance(lat1, lng1, lat2, lng2, elevation: ElevationProvider):
    straight = haversine_m(lat1, lng1, lat2, lng2)
    seg_dist = straight / (SLOPE_SAMPLE_COUNT - 1)
    heights = []
    for s in range(SLOPE_SAMPLE_COUNT):
        t = s / (SLOPE_SAMPLE_COUNT - 1)
        lat = lat1 + (lat2 - lat1) * t
        lng = lng1 + (lng2 - lng1) * t
        h = elevation.get_elevation(lat, lng)
        heights.append(h if h is not None else 0.0)
    total = 0.0
    for k in range(len(heights) - 1):
        rise = abs(heights[k + 1] - heights[k])
        gradient = min(rise / max(seg_dist, 1), SLOPE_GRADIENT_CAP)
        total += seg_dist * (1 + SLOPE_PENALTY_FACTOR_GENERAL * gradient)
    return straight, total


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args()
    buildings_file = "buildings.json" if args.full else "buildings_sample.json"
    scores_file = (
        "../../public/data/building-network-scores.json" if args.full else "sample_scores.json"
    )
    buildings = json.loads((SCRIPT_DIR / buildings_file).read_text())
    bus_stops_all = json.loads(BUS_STOPS_JSON.read_text())["busStops"]
    bus_stops = [s for s in bus_stops_all if any(k in s["operator"] for k in MAJOR_OPERATOR_KEYWORDS)]
    stations = json.loads(TRAIN_STATIONS_JSON.read_text())["stations"]
    network_results = {r["buildingId"]: r for r in json.loads((SCRIPT_DIR / scores_file).read_text())}

    elevation = ElevationProvider()

    rows = []
    for b in buildings:
        if b["buildingId"] not in network_results:
            continue
        best_bus = min(bus_stops, key=lambda s: haversine_m(b["lat"], b["lng"], s["lat"], s["lng"]))
        best_station = min(stations, key=lambda s: haversine_m(b["lat"], b["lng"], s["lat"], s["lng"]))

        _, bus_eff = straight_effective_distance(b["lat"], b["lng"], best_bus["lat"], best_bus["lng"], elevation)
        _, station_eff = straight_effective_distance(
            b["lat"], b["lng"], best_station["lat"], best_station["lng"], elevation
        )
        coverage_ratio = min(bus_eff / BUS_COVERAGE_THRESHOLD_METERS, station_eff / STATION_COVERAGE_THRESHOLD_METERS)

        net = network_results[b["buildingId"]]
        rows.append(
            {
                "buildingId": b["buildingId"],
                "straightBusEff": bus_eff,
                "networkBusEff": net["busEffectiveDistanceM_general"],
                "straightCoverage": coverage_ratio,
                "networkCoverage": net["coverageRatio_general"],
                "straightCovered": coverage_ratio <= 1,
                "networkCovered": net["isCovered_general"],
            }
        )

    n = len(rows)
    straight_covered = sum(1 for r in rows if r["straightCovered"])
    network_covered = sum(1 for r in rows if r["networkCovered"])
    detour_factors = [r["networkBusEff"] / r["straightBusEff"] for r in rows if r["straightBusEff"] > 1]

    print(f"サンプル数: {n}")
    print(f"直線ベース カバー率: {straight_covered}/{n} = {straight_covered / n * 100:.1f}%")
    print(f"道路網ベース カバー率: {network_covered}/{n} = {network_covered / n * 100:.1f}%")
    print(
        f"バス実効距離の detour factor（道路網/直線）: "
        f"平均={sum(detour_factors) / len(detour_factors):.2f} "
        f"中央値={sorted(detour_factors)[len(detour_factors) // 2]:.2f} "
        f"最大={max(detour_factors):.2f} 最小={min(detour_factors):.2f}"
    )
    flipped = [r for r in rows if r["straightCovered"] and not r["networkCovered"]]
    print(f"「直線ではカバーされているが道路網では空白地」に転じた件数: {len(flipped)}")
    for r in sorted(flipped, key=lambda r: -r["networkBusEff"])[:5]:
        print(f"  {r['buildingId']}: 直線={r['straightBusEff']:.0f}m -> 道路網={r['networkBusEff']:.0f}m")


if __name__ == "__main__":
    main()
