import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load = createRequire(`${process.env.TRANSIT_TEST_BUILD}/test.cjs`);
const { TileWorkGate } = load('./async-generation.js');
const { NetworkRouter } = load('./network-routing.js');
const { buildGreedyDemandTransitPlan, evaluateCustomStopsSimulation } = load('./transit-analysis.js');

test('old work cannot overwrite a newer generation; duplicate work is suppressed',async()=>{
  const gate=new TileWorkGate(), tile={}; let release; let value=''; let calls=0;
  const old=gate.run(tile,async g=>{calls++;await new Promise(r=>release=r);if(g===gate.generation)value='old';return true;});
  await gate.run(tile,async()=>{calls++;return true;});
  assert.equal(calls,1);
  gate.invalidate();
  await gate.run(tile,async()=>{value='new';return true;});
  release(); await old;
  assert.equal(value,'new');
});
test('transient failures retry after backoff; successful work is cached',async()=>{
  const gate=new TileWorkGate(),tile={};let calls=0;
  await gate.run(tile,async()=>{calls++;throw Error('temporary');});
  await gate.run(tile,async()=>{calls++;return true;}); assert.equal(calls,1);
  await gate.run(tile,async()=>{calls++;return true;},Date.now()+30001);
  await gate.run(tile,async()=>{calls++;return true;},Date.now()+60000);assert.equal(calls,2);
});
test('new stop on a split road reaches a building via its access edge',()=>{
  const graph={version:'test',missingElevationNodes:0,nodes:[[139,35,0],[139.0005,35,0],[139.001,35,0],[139.0005,35.00001,0]],edges:[[0,1,50,50,50,1],[1,2,50,50,50,1],[1,3,10,20,30,0]]};
  const result=new NetworkRouter(graph,'general').fromCandidate(35,139.0007);
  assert.ok(Math.abs(result.distances[3]-40)<.1);
  assert.ok(Math.abs(result.lng-139.0007)<1e-8);
  assert.ok(Math.abs(new NetworkRouter(graph,'elderly').fromCandidate(35,139.0007).distances[3]-50)<.1);
});
test('routing respects a detour instead of using cross-barrier straight distance',()=>{
  const graph={version:'test',missingElevationNodes:0,nodes:[[139,35,0],[139.001,35,0],[139.001,35.001,0],[139,35.001,0]],edges:[[0,1,100,100,100,1],[1,2,100,100,100,1],[2,3,100,100,100,1]]};
  const result=new NetworkRouter(graph,'general').fromCandidate(35,139);
  assert.equal(result.distances[3],300);
});
test('additional sites never worsen access and empty targets are supported',()=>{
  assert.deepEqual(buildGreedyDemandTransitPlan([],10,1),{sites:[],results:[]});
  const members=Array.from({length:20},(_,i)=>({lat:35+i*.001,lng:139,busStraightDistanceMeters:500,busEffectiveDistanceMeters:700,stationEffectiveDistanceMeters:2000,coverageRatio:700/300}));
  const {results}=buildGreedyDemandTransitPlan(members,10,1);
  for(let i=0;i<results.length;i++) {
    assert.ok(results[i].averageAfterMeters <= (i?results[i-1].averageAfterMeters:700));
    assert.ok(results[i].newlyCoveredBuildings <= members.length);
  }
});
test('evaluateCustomStopsSimulation aggregates newly covered buildings across multiple custom stops',()=>{
  const buildings = [
    { buildingId: 'b1', lat: 35.36, lng: 139.45, baseBusEffectiveDistanceMeters: 520, baseStationEffectiveDistanceMeters: 1200, baseCoverageRatio: 520 / 300, totalFloorArea: 120 },
    { buildingId: 'b2', lat: 35.361, lng: 139.451, baseBusEffectiveDistanceMeters: 410, baseStationEffectiveDistanceMeters: 1200, baseCoverageRatio: 410 / 300, totalFloorArea: 80 },
    { buildingId: 'b3', lat: 35.362, lng: 139.452, baseBusEffectiveDistanceMeters: 180, baseStationEffectiveDistanceMeters: 1200, baseCoverageRatio: 180 / 300, totalFloorArea: 100 },
  ];
  const stops = [
    { id: 1, label: '仮設停留所 #1', lat: 35.36, lng: 139.45 },
    { id: 2, label: '仮設停留所 #2', lat: 35.361, lng: 139.451 },
  ];
  const stopDistanceMap = new Map([
    [1, new Map([['b1', 210], ['b2', 290]])],
    [2, new Map([['b2', 140]])],
  ]);
  const { outcomes, summary } = evaluateCustomStopsSimulation(buildings, stops, stopDistanceMap, 1);
  assert.equal(summary.stopCount, 2);
  assert.equal(summary.totalGapBuildingsBefore, 2);
  assert.equal(summary.newlyCoveredBuildings, 2);
  assert.equal(summary.newlyCoveredFloorArea, 200);
  assert.equal(summary.remainingGapBuildings, 0);
  assert.equal(summary.severeGapBeforeBuildings, 1);
  assert.equal(summary.severeGapAfterBuildings, 0);
  assert.equal(summary.perStopStats[0].standaloneCoveredBuildings, 2);
  assert.equal(summary.perStopStats[0].primaryCoveredBuildings, 1);
  assert.equal(summary.perStopStats[1].standaloneCoveredBuildings, 1);
  assert.equal(summary.perStopStats[1].primaryCoveredBuildings, 1);
  assert.equal(outcomes.get('b1')?.isNewlyCovered, true);
  assert.equal(outcomes.get('b1')?.bestStopId, 1);
  assert.equal(outcomes.get('b2')?.bestStopId, 2);
  assert.equal(outcomes.get('b2')?.afterBusEffectiveDistanceMeters, 140);
});
test('evaluateCustomStopsSimulation respects thresholdMultiplier for custom stop coverage without falsely covering distant gap buildings',()=>{
  const buildings = [
    { buildingId: 'nearCustom', lat: 35.36, lng: 139.45, baseBusEffectiveDistanceMeters: 480, baseStationEffectiveDistanceMeters: 1200, baseCoverageRatio: 480 / 300, totalFloorArea: 100 },
    { buildingId: 'farFromCustom', lat: 35.37, lng: 139.46, baseBusEffectiveDistanceMeters: 330, baseStationEffectiveDistanceMeters: 1200, baseCoverageRatio: 330 / 300, totalFloorArea: 100 },
  ];
  const stops = [{ id: 1, label: '仮設停留所 #1', lat: 35.36, lng: 139.45 }];
  const stopDistanceMap = new Map([[1, new Map([['nearCustom', 340]])]]);
  const res10 = evaluateCustomStopsSimulation(buildings, stops, stopDistanceMap, 1.0);
  assert.equal(res10.summary.newlyCoveredBuildings, 0);
  assert.equal(res10.outcomes.get('nearCustom')?.isNewlyCovered, false);

  const res12 = evaluateCustomStopsSimulation(buildings, stops, stopDistanceMap, 1.2);
  assert.equal(res12.summary.newlyCoveredBuildings, 1);
  assert.equal(res12.outcomes.get('nearCustom')?.isNewlyCovered, true);
  assert.equal(res12.outcomes.has('farFromCustom'), false);
});
