const EARTH_RADIUS_METERS = 6371000;
export const BUS_COVERAGE_THRESHOLD_METERS = 300;
export const STATION_COVERAGE_THRESHOLD_METERS = 600;
export type WalkProfile = "general" | "elderly";
export const WALK_PROFILES: Record<WalkProfile, { label: string; slopePenaltyFactor: number; walkSpeedMPerMin: number }> = {
  // 勾配1あたり実効距離を何倍割り増しするかの係数。例: 勾配0.1(10%)ならslopePenaltyFactor=3で
  // 実効距離が1.3倍になる。徒歩速度は分速67m≒時速4kmが一般的な成人の目安。
  general: { label: "一般（標準の坂道補正）", slopePenaltyFactor: 3, walkSpeedMPerMin: 67 },
  elderly: { label: "高齢者（坂道の負荷係数2倍）", slopePenaltyFactor: 6, walkSpeedMPerMin: 50 },
};
export type DistanceModel = "straight" | "network";
export const DISTANCE_MODEL_DEFAULT: DistanceModel = "straight";
export const BUILDING_NETWORK_SCORES_JSON_URL = "/data/building-network-scores.json";
export type BuildingNetworkScoreRow = {
  buildingId: string;
  networkNode: number;
  datasetVersion: string;
  nearestStopName_general: string;
  nearestStopName_elderly: string;
  nearestStationName_general: string;
  nearestStationName_elderly: string;
  busNetworkDistanceM_elderly: number;
  stationNetworkDistanceM_elderly: number;
  lat: number;
  lng: number;
  usage: string;
  totalFloorArea: number | null;
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

export type DemandTransitPlanResult = {
  count: number;
  averageBeforeMeters: number;
  averageAfterMeters: number;
  farthestTenPercentBeforeMeters: number;
  farthestTenPercentAfterMeters: number;
  newlyCoveredBuildings: number;
  severeGapBeforeBuildings: number;
  severeGapAfterBuildings: number;
};
export type DemandTransitPlanAnalysis = {
  targetBuildingCount: number;
  scopeLabel: string;
  methodLabel: string;
  thresholdMultiplier: number;
  results: DemandTransitPlanResult[];
};
export type DemandTransitMember = {
  networkNode?: number;
  lat: number;
  lng: number;
  busStraightDistanceMeters: number;
  busEffectiveDistanceMeters: number;
  stationEffectiveDistanceMeters: number;
  coverageRatio: number;
};
export type DemandTransitPlanSite = { lat: number; lng: number; x: number; y: number; distances?: number[] };

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function projectToLocalMeters(lat: number, lng: number, refLat: number, refLng: number): [number, number] {
  const refLatRad = (refLat * Math.PI) / 180;
  return [(lng - refLng) * 111320 * Math.cos(refLatRad), (lat - refLat) * 110540];
}
export function unprojectFromLocalMeters(x: number, y: number, refLat: number, refLng: number): [number, number] {
  const refLatRad = (refLat * Math.PI) / 180;
  return [refLat + y / 110540, refLng + x / (111320 * Math.cos(refLatRad))];
}

// シンプルなk-means実装（Lloyd法）。既存の依存関係に軽量なk-means実装が無いため自前で用意する。
// 初期中心点はx座標でソートしてk等分した位置から選ぶ決定的な方法（乱数を使わず、毎回同じ結果になる）。
export function kMeans(
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

// 乗り場候補は、交通空白地の建物を400m格子にまとめた重心から選ぶ。各手順で「既存バス停と
// すでに選んだ乗り場のうち最も近い距離」を更新し、総短縮量が最も大きい地点を一つだけ追加する。
// これにより、k-meansのように候補数ごとに配置全体が入れ替わらず、1か所案→2か所案→…が
// 必ず入れ子になる。実際の道路沿いの設置可否は別途確認が必要だが、追加数比較の目的関数を
// 「建物の散らばり」ではなく「交通アクセスの改善」に揃えられる。
export const DEMAND_TRANSIT_CANDIDATE_GRID_METERS = 400;
export function buildGreedyDemandTransitPlan(
  members: DemandTransitMember[],
  maxSites: number,
  thresholdMultiplier: number
): { sites: DemandTransitPlanSite[]; results: DemandTransitPlanResult[] } {
  if (members.length === 0) return { sites: [], results: [] };
  const refLat = members.reduce((sum, building) => sum + building.lat, 0) / members.length;
  const refLng = members.reduce((sum, building) => sum + building.lng, 0) / members.length;
  const points = members.map((building) => projectToLocalMeters(building.lat, building.lng, refLat, refLng));
  const slopeLoads = members.map((building) =>
    Math.max(1, building.busEffectiveDistanceMeters / Math.max(building.busStraightDistanceMeters, 1))
  );

  const grid = new Map<string, { xSum: number; ySum: number; count: number }>();
  points.forEach(([x, y]) => {
    const key = `${Math.floor(x / DEMAND_TRANSIT_CANDIDATE_GRID_METERS)},${Math.floor(y / DEMAND_TRANSIT_CANDIDATE_GRID_METERS)}`;
    const cell = grid.get(key) ?? { xSum: 0, ySum: 0, count: 0 };
    cell.xSum += x;
    cell.ySum += y;
    cell.count++;
    grid.set(key, cell);
  });
  const candidateSites: DemandTransitPlanSite[] = [...grid.values()].map((cell) => {
    const x = cell.xSum / cell.count;
    const y = cell.ySum / cell.count;
    const [lat, lng] = unprojectFromLocalMeters(x, y, refLat, refLng);
    return { lat, lng, x, y };
  });

  const currentDistances = members.map((building) => building.busEffectiveDistanceMeters);
  const averageBeforeMeters = currentDistances.reduce((sum, distance) => sum + distance, 0) / members.length;
  const farthestCount = Math.max(1, Math.ceil(members.length * 0.1));
  const farthestIndices = new Set(
    [...members.keys()]
      .sort((a, b) => members[b].busEffectiveDistanceMeters - members[a].busEffectiveDistanceMeters)
      .slice(0, farthestCount)
  );
  const farthestTenPercentBeforeMeters =
    [...farthestIndices].reduce((sum, index) => sum + members[index].busEffectiveDistanceMeters, 0) / farthestCount;
  const severeGapBeforeBuildings = members.filter((building) => building.coverageRatio > 1.5).length;
  const selectedCandidateIndices = new Set<number>();
  const sites: DemandTransitPlanSite[] = [];
  const results: DemandTransitPlanResult[] = [];

  for (let step = 0; step < Math.min(maxSites, candidateSites.length); step++) {
    let bestCandidateIndex = -1;
    let bestTotalImprovement = -Infinity;
    for (let candidateIndex = 0; candidateIndex < candidateSites.length; candidateIndex++) {
      if (selectedCandidateIndices.has(candidateIndex)) continue;
      const candidate = candidateSites[candidateIndex];
      let totalImprovement = 0;
      for (let i = 0; i < members.length; i++) {
        const candidateDistance = haversineMeters(members[i].lat, members[i].lng, candidate.lat, candidate.lng) * slopeLoads[i];
        if (candidateDistance < currentDistances[i]) totalImprovement += currentDistances[i] - candidateDistance;
      }
      if (totalImprovement > bestTotalImprovement) {
        bestTotalImprovement = totalImprovement;
        bestCandidateIndex = candidateIndex;
      }
    }
    if (bestCandidateIndex < 0) break;

    selectedCandidateIndices.add(bestCandidateIndex);
    const selectedSite = candidateSites[bestCandidateIndex];
    sites.push(selectedSite);
    for (let i = 0; i < members.length; i++) {
      const candidateDistance = haversineMeters(members[i].lat, members[i].lng, selectedSite.lat, selectedSite.lng) * slopeLoads[i];
      if (candidateDistance < currentDistances[i]) currentDistances[i] = candidateDistance;
    }

    let farthestAfterTotal = 0;
    let newlyCoveredBuildings = 0;
    let severeGapAfterBuildings = 0;
    for (let i = 0; i < members.length; i++) {
      const afterDistance = currentDistances[i];
      if (farthestIndices.has(i)) farthestAfterTotal += afterDistance;
      if (members[i].coverageRatio > 1 && afterDistance <= BUS_COVERAGE_THRESHOLD_METERS * thresholdMultiplier) {
        newlyCoveredBuildings++;
      }
      const coverageRatioAfter = Math.min(
        afterDistance / (BUS_COVERAGE_THRESHOLD_METERS * thresholdMultiplier),
        members[i].stationEffectiveDistanceMeters / (STATION_COVERAGE_THRESHOLD_METERS * thresholdMultiplier)
      );
      if (coverageRatioAfter > 1.5) severeGapAfterBuildings++;
    }
    results.push({
      count: sites.length,
      averageBeforeMeters,
      averageAfterMeters: currentDistances.reduce((sum, distance) => sum + distance, 0) / members.length,
      farthestTenPercentBeforeMeters,
      farthestTenPercentAfterMeters: farthestAfterTotal / farthestCount,
      newlyCoveredBuildings,
      severeGapBeforeBuildings,
      severeGapAfterBuildings,
    });
  }
  return { sites, results };
}

export type CustomStopSite = {
  id: number;
  label: string;
  lat: number;
  lng: number;
};

export type CustomStopBuildingRecord = {
  buildingId: string;
  lat: number;
  lng: number;
  baseBusEffectiveDistanceMeters: number;
  baseStationEffectiveDistanceMeters: number;
  baseCoverageRatio: number;
  totalFloorArea: number | null;
};

export type CustomStopBuildingOutcome = {
  bestStopId: number | null;
  bestStopLabel: string | null;
  bestCustomDistanceMeters: number;
  afterBusEffectiveDistanceMeters: number;
  afterCoverageRatio: number;
  isNewlyCovered: boolean;
  isImprovedGap: boolean;
};

export type CustomStopPerSiteStat = {
  id: number;
  label: string;
  lat: number;
  lng: number;
  standaloneCoveredBuildings: number;
  primaryCoveredBuildings: number;
};

export type CustomStopSimulationSummary = {
  stopCount: number;
  totalGapBuildingsBefore: number;
  newlyCoveredBuildings: number;
  newlyCoveredFloorArea: number;
  remainingGapBuildings: number;
  severeGapBeforeBuildings: number;
  severeGapAfterBuildings: number;
  improvedGapBuildingsCount: number;
  averageImprovedBusBeforeMeters: number | null;
  averageImprovedBusAfterMeters: number | null;
  perStopStats: CustomStopPerSiteStat[];
};

export function evaluateCustomStopsSimulation(
  buildings: Iterable<CustomStopBuildingRecord>,
  stops: CustomStopSite[],
  stopDistanceMap: ReadonlyMap<number, ReadonlyMap<string, number>>,
  thresholdMultiplier = 1
): {
  outcomes: Map<string, CustomStopBuildingOutcome>;
  summary: CustomStopSimulationSummary;
} {
  const busThreshold = BUS_COVERAGE_THRESHOLD_METERS * thresholdMultiplier;
  const stationThreshold = STATION_COVERAGE_THRESHOLD_METERS * thresholdMultiplier;
  const outcomes = new Map<string, CustomStopBuildingOutcome>();

  const standaloneCounts = new Map<number, number>();
  const primaryCounts = new Map<number, number>();
  for (const stop of stops) {
    standaloneCounts.set(stop.id, 0);
    primaryCounts.set(stop.id, 0);
  }

  let totalGapBuildingsBefore = 0;
  let newlyCoveredBuildings = 0;
  let newlyCoveredFloorArea = 0;
  let remainingGapBuildings = 0;
  let severeGapBeforeBuildings = 0;
  let severeGapAfterBuildings = 0;
  let improvedGapBuildingsCount = 0;
  let improvedBusBeforeSum = 0;
  let improvedBusAfterSum = 0;

  for (const b of buildings) {
    const isGapBefore = b.baseCoverageRatio > 1;
    if (isGapBefore) {
      totalGapBuildingsBefore++;
      if (b.baseCoverageRatio > 1.5) {
        severeGapBeforeBuildings++;
      }
    }

    let bestStopId: number | null = null;
    let bestStopLabel: string | null = null;
    let bestCustomDistanceMeters = Infinity;

    for (const stop of stops) {
      const dist = stopDistanceMap.get(stop.id)?.get(b.buildingId);
      if (
        dist !== undefined &&
        Number.isFinite(dist) &&
        dist < b.baseBusEffectiveDistanceMeters
      ) {
        if (isGapBefore && dist <= busThreshold) {
          standaloneCounts.set(stop.id, (standaloneCounts.get(stop.id) ?? 0) + 1);
        }
        if (dist < bestCustomDistanceMeters) {
          bestCustomDistanceMeters = dist;
          bestStopId = stop.id;
          bestStopLabel = stop.label;
        }
      }
    }

    const afterBusEffectiveDistanceMeters = Math.min(
      b.baseBusEffectiveDistanceMeters,
      bestCustomDistanceMeters
    );
    const isNewlyCovered = isGapBefore && bestCustomDistanceMeters <= busThreshold;
    const afterCoverageRatio =
      bestCustomDistanceMeters < b.baseBusEffectiveDistanceMeters
        ? Math.min(
            b.baseCoverageRatio,
            bestCustomDistanceMeters / busThreshold,
            b.baseStationEffectiveDistanceMeters / stationThreshold
          )
        : b.baseCoverageRatio;
    const isImprovedGap =
      isGapBefore &&
      (afterBusEffectiveDistanceMeters < b.baseBusEffectiveDistanceMeters - 0.5 || isNewlyCovered);

    if (isGapBefore) {
      if (isNewlyCovered) {
        newlyCoveredBuildings++;
        if (b.totalFloorArea != null && Number.isFinite(b.totalFloorArea)) {
          newlyCoveredFloorArea += b.totalFloorArea;
        }
        if (bestStopId !== null) {
          primaryCounts.set(bestStopId, (primaryCounts.get(bestStopId) ?? 0) + 1);
        }
      } else {
        remainingGapBuildings++;
      }
      if (afterCoverageRatio > 1.5) {
        severeGapAfterBuildings++;
      }
      if (isImprovedGap) {
        improvedGapBuildingsCount++;
        improvedBusBeforeSum += b.baseBusEffectiveDistanceMeters;
        improvedBusAfterSum += afterBusEffectiveDistanceMeters;
      }
    }

    if (stops.length > 0 && bestCustomDistanceMeters < b.baseBusEffectiveDistanceMeters) {
      outcomes.set(b.buildingId, {
        bestStopId,
        bestStopLabel,
        bestCustomDistanceMeters,
        afterBusEffectiveDistanceMeters,
        afterCoverageRatio,
        isNewlyCovered,
        isImprovedGap,
      });
    }
  }

  const perStopStats: CustomStopPerSiteStat[] = stops.map((stop) => ({
    id: stop.id,
    label: stop.label,
    lat: stop.lat,
    lng: stop.lng,
    standaloneCoveredBuildings: standaloneCounts.get(stop.id) ?? 0,
    primaryCoveredBuildings: primaryCounts.get(stop.id) ?? 0,
  }));

  return {
    outcomes,
    summary: {
      stopCount: stops.length,
      totalGapBuildingsBefore,
      newlyCoveredBuildings,
      newlyCoveredFloorArea,
      remainingGapBuildings,
      severeGapBeforeBuildings,
      severeGapAfterBuildings,
      improvedGapBuildingsCount,
      averageImprovedBusBeforeMeters:
        improvedGapBuildingsCount > 0 ? improvedBusBeforeSum / improvedGapBuildingsCount : null,
      averageImprovedBusAfterMeters:
        improvedGapBuildingsCount > 0 ? improvedBusAfterSum / improvedGapBuildingsCount : null,
      perStopStats,
    },
  };
}

