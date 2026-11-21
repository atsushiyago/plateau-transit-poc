import { haversineMeters, projectToLocalMeters } from './transit-analysis';
export type RoutingGraph = {
  version: string;
  nodes: [number, number, number | null][];
  edges: [number, number, number, number, number, number][];
  missingElevationNodes: number;
};

export type RoutePathResult = {
  straightMeters: number;
  networkMeters: number;
  effectiveMeters: number;
  path: { lat: number; lng: number }[];
};

// Binary heap keeps ten whole-area route searches off the UI thread and O(E log V).
class MinHeap {
  private items: [number, number][] = [];
  peekCost() {
    return this.items.length ? this.items[0][0] : Infinity;
  }
  push(item: [number, number]) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p][0] <= item[0]) break;
      this.items[i] = this.items[p]; i = p;
    }
    this.items[i] = item;
  }
  pop() {
    if (!this.items.length) return undefined;
    const first = this.items[0], last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let c = i * 2 + 1;
        if (c + 1 < this.items.length && this.items[c + 1][0] < this.items[c][0]) c++;
        if (this.items[c][0] >= last[0]) break;
        this.items[i] = this.items[c]; i = c;
      }
      this.items[i] = last;
    }
    return first;
  }
}

export class NetworkRouter {
  // [nextNode, effectiveCost, physicalLength]
  private adjacency: [number, number, number][][];
  constructor(private graph: RoutingGraph, private profile: 'general' | 'elderly') {
    this.adjacency = Array.from({ length: graph.nodes.length }, () => []);
    for (const edge of graph.edges) {
      const [u, v, length] = edge;
      const cost = edge[profile === 'general' ? 3 : 4];
      this.adjacency[u].push([v, cost, length]);
      this.adjacency[v].push([u, cost, length]);
    }
  }
  private snapToRoadEdge(lat: number, lng: number) {
    let best: {
      u: number;
      v: number;
      t: number;
      edge: RoutingGraph['edges'][number];
      snapDistMeters: number;
    } | undefined;
    let minimum = Infinity;
    for (const edge of this.graph.edges) {
      const [u, v, , , , road] = edge;
      if (!road) continue;
      const a = this.graph.nodes[u], b = this.graph.nodes[v];
      const [ax, ay] = projectToLocalMeters(a[1], a[0], lat, lng);
      const [bx, by] = projectToLocalMeters(b[1], b[0], lat, lng);
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      const d = (ax + dx * t) ** 2 + (ay + dy * t) ** 2;
      if (d < minimum) {
        minimum = d;
        best = { u, v, t, edge, snapDistMeters: Math.sqrt(d) };
      }
    }
    if (!best) throw new Error('道路への接続点がありません');
    return best;
  }
  fromCandidate(lat: number, lng: number) {
    const { u, v, t, edge } = this.snapToRoadEdge(lat, lng);
    const cost = edge[this.profile === 'general' ? 3 : 4];
    const distances = new Float64Array(this.graph.nodes.length).fill(Infinity);
    const queue = new MinHeap();
    // Road segments already split at every building/stop projection. Inserting the
    // new site between these endpoints preserves same-edge distances.
    for (const [node, d] of [[u, cost * t], [v, cost * (1 - t)]]) {
      if (d < distances[node]) { distances[node] = d; queue.push([d, node]); }
    }
    let item;
    while ((item = queue.pop())) {
      const [d, node] = item;
      if (d !== distances[node]) continue;
      for (const [next, weight] of this.adjacency[node]) {
        const candidate = d + weight;
        if (candidate < distances[next]) { distances[next] = candidate; queue.push([candidate, next]); }
      }
    }
    const a = this.graph.nodes[u], b = this.graph.nodes[v];
    return { lat: a[1] + (b[1] - a[1]) * t, lng: a[0] + (b[0] - a[0]) * t, distances };
  }
  /**
   * 建物ノード(startNode)から目標地点(targetLat, targetLng)に最寄りの道路エッジまでの
   * 最短実効距離ルートを復元し、直線距離・実際の道のり・実効距離・経路座標を返す。
   */
  findPathFromNode(startNode: number, targetLat: number, targetLng: number): RoutePathResult | null {
    if (startNode < 0 || startNode >= this.graph.nodes.length) return null;
    const { u, v, t, edge, snapDistMeters } = this.snapToRoadEdge(targetLat, targetLng);
    const edgeCost = edge[this.profile === 'general' ? 3 : 4];
    const edgeLength = edge[2];

    const n = this.graph.nodes.length;
    const effDist = new Float64Array(n).fill(Infinity);
    const physDist = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const queue = new MinHeap();

    effDist[startNode] = 0;
    physDist[startNode] = 0;
    queue.push([0, startNode]);

    let bestTotalEff = Infinity;
    let item;
    while ((item = queue.pop())) {
      const [d, node] = item;
      if (d > bestTotalEff) break;
      if (d !== effDist[node]) continue;

      if (node === u) {
        bestTotalEff = Math.min(bestTotalEff, d + edgeCost * t);
      }
      if (node === v) {
        bestTotalEff = Math.min(bestTotalEff, d + edgeCost * (1 - t));
      }

      for (const [next, weight, len] of this.adjacency[node]) {
        const candidate = d + weight;
        if (candidate < effDist[next] && candidate < bestTotalEff) {
          effDist[next] = candidate;
          physDist[next] = physDist[node] + len;
          parent[next] = node;
          queue.push([candidate, next]);
        }
      }
    }

    const viaU = effDist[u] + edgeCost * t;
    const viaV = effDist[v] + edgeCost * (1 - t);
    const endEndpoint = viaU <= viaV ? u : v;
    const endEdgeEff = endEndpoint === u ? edgeCost * t : edgeCost * (1 - t);
    const endEdgePhys = endEndpoint === u ? edgeLength * t : edgeLength * (1 - t);

    if (!Number.isFinite(effDist[endEndpoint])) return null;

    const reversedNodes: number[] = [];
    for (let cur = endEndpoint; cur !== -1; cur = parent[cur]) {
      reversedNodes.push(cur);
    }
    reversedNodes.reverse();

    const path: { lat: number; lng: number }[] = reversedNodes.map((idx) => ({
      lat: this.graph.nodes[idx][1],
      lng: this.graph.nodes[idx][0],
    }));

    const a = this.graph.nodes[u], b = this.graph.nodes[v];
    const snappedLat = a[1] + (b[1] - a[1]) * t;
    const snappedLng = a[0] + (b[0] - a[0]) * t;
    path.push({ lat: snappedLat, lng: snappedLng });
    if (snapDistMeters > 0.5) {
      path.push({ lat: targetLat, lng: targetLng });
    }

    const startCoords = this.graph.nodes[startNode];
    const straightMeters = haversineMeters(startCoords[1], startCoords[0], targetLat, targetLng);

    return {
      straightMeters,
      networkMeters: physDist[endEndpoint] + endEdgePhys + snapDistMeters,
      effectiveMeters: effDist[endEndpoint] + endEdgeEff + snapDistMeters,
      path,
    };
  }
}
