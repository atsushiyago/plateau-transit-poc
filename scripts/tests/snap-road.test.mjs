import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("snap-road: snaps to real road edges (excluding building access edges)", async () => {
  const jsonPath = path.join(process.cwd(), "public", "data", "routing-graph.json");
  assert.ok(fs.existsSync(jsonPath), "routing-graph.json should exist");

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.nodes) && Array.isArray(data.edges));

  // Extract real road edges only
  const roadEdges = [];
  for (let i = 0; i < data.edges.length; i++) {
    if (data.edges[i][5] === 1) {
      roadEdges.push([data.edges[i][0], data.edges[i][1]]);
    }
  }
  assert.ok(roadEdges.length > 200000, "should have > 200k real road edges");

  // Take a real road edge
  const [u, v] = roadEdges[100];
  const [lngA, latA] = data.nodes[u];
  const [lngB, latB] = data.nodes[v];

  // Midpoint of road edge
  const midLat = (latA + latB) / 2;
  const midLng = (lngA + lngB) / 2;

  // Jitter slightly to the side (e.g. 10m off road)
  const jitterLat = midLat + 0.00008; // ~8.8m
  const jitterLng = midLng + 0.00008;

  const GRID_DEG = 0.005;
  const grid = new Map();
  for (let i = 0; i < roadEdges.length; i++) {
    const [uIdx, vIdx] = roadEdges[i];
    const [l1, a1] = data.nodes[uIdx];
    const [l2, a2] = data.nodes[vIdx];
    const minGx = Math.floor(Math.min(l1, l2) / GRID_DEG);
    const maxGx = Math.floor(Math.max(l1, l2) / GRID_DEG);
    const minGy = Math.floor(Math.min(a1, a2) / GRID_DEG);
    const maxGy = Math.floor(Math.max(a1, a2) / GRID_DEG);
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const key = `${gx}_${gy}`;
        let cell = grid.get(key);
        if (!cell) { cell = []; grid.set(key, cell); }
        cell.push(i);
      }
    }
  }

  function snap(qLat, qLng, maxDist = 35) {
    const gx = Math.floor(qLng / GRID_DEG);
    const gy = Math.floor(qLat / GRID_DEG);
    const cosLat = Math.cos((qLat * Math.PI) / 180);
    let bestDist = Infinity;
    let bestPoint = null;
    const checked = new Set();

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx}_${gy + dy}`);
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const edgeIdx = cell[k];
          if (checked.has(edgeIdx)) continue;
          checked.add(edgeIdx);
          const [u, v] = roadEdges[edgeIdx];
          const [lA, tA] = data.nodes[u];
          const [lB, tB] = data.nodes[v];

          const ax = (lA - qLng) * 111000 * cosLat;
          const ay = (tA - qLat) * 111000;
          const bx = (lB - qLng) * 111000 * cosLat;
          const by = (tB - qLat) * 111000;
          const abx = bx - ax;
          const aby = by - ay;
          const abLenSq = abx * abx + aby * aby;
          let t = 0;
          if (abLenSq > 0) {
            t = Math.max(0, Math.min(1, (-ax * abx - ay * aby) / abLenSq));
          }
          const dist = Math.hypot(ax + t * abx, ay + t * aby);
          if (dist < bestDist) {
            bestDist = dist;
            bestPoint = { lat: tA + t * (tB - tA), lng: lA + t * (lB - lA) };
          }
        }
      }
    }
    return { snapped: bestDist <= maxDist, distanceMeters: bestDist, bestPoint };
  }

  // 1. Point 10m off road should snap to the road segment
  const nearResult = snap(jitterLat, jitterLng, 35);
  assert.equal(nearResult.snapped, true);
  assert.ok(nearResult.distanceMeters <= 35);
  assert.ok(nearResult.bestPoint !== null);

  // 2. Point far away should NOT snap
  const farResult = snap(35.2500, 139.4000, 35);
  assert.equal(farResult.snapped, false);
});
