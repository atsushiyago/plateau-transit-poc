import { buildGreedyDemandTransitPlan, haversineMeters, BUILDING_NETWORK_SCORES_JSON_URL, type BuildingNetworkScoreRow, type DemandTransitMember, type DemandTransitPlanSite, type DemandTransitPlanResult, type WalkProfile, type DistanceModel } from '../lib/transit-analysis';
import { NetworkRouter, type RoutingGraph } from '../lib/network-routing';
export type AnalysisRequest = {
  profile: WalkProfile; model: DistanceModel; thresholdMultiplier: number;
  stops: { lat: number; lng: number }[]; stations: { lat: number; lng: number }[];
};
export type AnalysisResponse = {
  members: DemandTransitMember[]; sites: DemandTransitPlanSite[];
  results: DemandTransitPlanResult[]; total: number; methodLabel: string;
} | { error: string };

self.onmessage = async (event: MessageEvent<AnalysisRequest>) => {
  try {
    const { profile, model, thresholdMultiplier, stops, stations } = event.data;
    const res = await fetch(BUILDING_NETWORK_SCORES_JSON_URL);
    if (!res.ok) throw new Error('全域データを取得できませんでした');
    const rows: BuildingNetworkScoreRow[] = await res.json();
    const members: DemandTransitMember[] = [];
    for (const row of rows) {
      const busPhysical = profile === 'general' ? row.busNetworkDistanceM : row.busNetworkDistanceM_elderly;
      const stationPhysical = profile === 'general' ? row.stationNetworkDistanceM : row.stationNetworkDistanceM_elderly;
      let bus = row[`busEffectiveDistanceM_${profile}`];
      let station = row[`stationEffectiveDistanceM_${profile}`];
      let physical = busPhysical;
      if (model === 'straight') {
        physical = Math.min(...stops.map(s => haversineMeters(row.lat,row.lng,s.lat,s.lng)));
        const nearestStation = Math.min(...stations.map(s => haversineMeters(row.lat,row.lng,s.lat,s.lng)));
        bus = physical * Math.max(1, bus / Math.max(busPhysical, 1));
        station = nearestStation * Math.max(1, station / Math.max(stationPhysical, 1));
      }
      const coverageRatio = Math.min(bus / (300 * thresholdMultiplier), station / (600 * thresholdMultiplier));
      if (coverageRatio > 1) members.push({ lat:row.lat,lng:row.lng,networkNode:row.networkNode,busStraightDistanceMeters:physical,busEffectiveDistanceMeters:bus,stationEffectiveDistanceMeters:station,coverageRatio });
    }
    const plan = buildGreedyDemandTransitPlan(members,10,thresholdMultiplier);
    let methodLabel = '直線距離×既存道路経路の傾斜倍率で前後を比較した概算。地図の地形サンプリングとは異なるため、対象棟数や距離に差が出ます。';
    if (model === 'network' && members.length) {
      const graphRes = await fetch('/data/routing-graph.json');
      if (!graphRes.ok) throw new Error('道路網を取得できませんでした');
      const graph: RoutingGraph = await graphRes.json();
      if (!rows.length || graph.version !== rows[0].datasetVersion) throw new Error('道路網と建物データの版が一致しません。再読み込みしてください');
      const router = new NetworkRouter(graph,profile);
      const current = members.map(m=>m.busEffectiveDistanceMeters);
      const farthest = [...members.keys()].sort((a,b)=>current[b]-current[a]).slice(0,Math.max(1,Math.ceil(members.length*.1)));
      const averageBefore = current.reduce((a,b)=>a+b,0)/current.length;
      const farthestBefore = farthest.reduce((sum,i)=>sum+current[i],0)/farthest.length;
      const severeBefore = members.filter(m=>m.coverageRatio>1.5).length;
      plan.results = [];
      for (const site of plan.sites) {
        const routed = router.fromCandidate(site.lat,site.lng);
        site.lat = routed.lat; site.lng = routed.lng;
        site.distances = members.map(m=>routed.distances[m.networkNode!]);
        for (let i=0;i<current.length;i++) current[i]=Math.min(current[i],site.distances[i]);
        plan.results.push({count:plan.results.length+1,averageBeforeMeters:averageBefore,averageAfterMeters:current.reduce((a,b)=>a+b,0)/current.length,
          farthestTenPercentBeforeMeters:farthestBefore,farthestTenPercentAfterMeters:farthest.reduce((sum,i)=>sum+current[i],0)/farthest.length,
          newlyCoveredBuildings:current.filter(d=>d<=300*thresholdMultiplier).length,severeGapBeforeBuildings:severeBefore,
          severeGapAfterBuildings:members.filter((m,i)=>Math.min(current[i]/(300*thresholdMultiplier),m.stationEffectiveDistanceMeters/(600*thresholdMultiplier))>1.5).length});
      }
      methodLabel = '候補の順位は概算で選定し、道路上へ補正。改善前後とも同じ道路網・勾配モデルの最小実効距離で再評価しています。道路網での最適配置を保証するものではありません。';
      if(graph.missingElevationNodes) methodLabel += '一部の道路は標高欠測のため傾斜補正なし。';
    } else {
      for (const site of plan.sites) site.distances = members.map(m => haversineMeters(m.lat,m.lng,site.lat,site.lng)*Math.max(1,m.busEffectiveDistanceMeters/Math.max(m.busStraightDistanceMeters,1)));
    }
    self.postMessage({members,sites:plan.sites,results:plan.results,total:rows.length,methodLabel} satisfies AnalysisResponse);
  } catch (error) {
    self.postMessage({error:error instanceof Error?error.message:'比較に失敗しました'} satisfies AnalysisResponse);
  }
};
