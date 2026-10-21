import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load = createRequire(`${process.env.TRANSIT_TEST_BUILD}/test.cjs`);
const { TileWorkGate } = load('./async-generation.js');
const { NetworkRouter } = load('./network-routing.js');
const { buildGreedyDemandTransitPlan } = load('./transit-analysis.js');

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
