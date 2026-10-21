import { projectToLocalMeters } from './transit-analysis';
export type RoutingGraph = {
  version: string;
  nodes: [number, number, number | null][];
  edges: [number, number, number, number, number, number][];
  missingElevationNodes: number;
};

// Binary heap keeps ten whole-area route searches off the UI thread and O(E log V).
class MinHeap {
  private items: [number, number][] = [];
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
  private adjacency: [number, number][][];
  constructor(private graph: RoutingGraph, private profile: 'general' | 'elderly') {
    this.adjacency = Array.from({ length: graph.nodes.length }, () => []);
    for (const edge of graph.edges) {
      const [u, v] = edge, cost = edge[profile === 'general' ? 3 : 4];
      this.adjacency[u].push([v, cost]); this.adjacency[v].push([u, cost]);
    }
  }
  fromCandidate(lat: number, lng: number) {
    let best: { u: number; v: number; t: number; edge: RoutingGraph['edges'][number] } | undefined;
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
      if (d < minimum) { minimum = d; best = { u, v, t, edge }; }
    }
    if (!best) throw new Error('道路への接続点がありません');
    const { u, v, t, edge } = best;
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
}
