"""Edge splitting and shortest effective-distance routing shared by generation/tests."""
import heapq
import itertools
from collections import defaultdict


def split_snap_groups(graph, groups):
    """Insert all snapped groups together; preserve parallel edges and edge lengths.

    groups: [(prefix, snap_batch_result), ...]. Snap against the unmodified graph.
    """
    edges = defaultdict(list)
    outputs = []
    for prefix, snapped in groups:
        result = []
        for i, (u, v, key, lat, lng, du, dv, perp) in enumerate(snapped):
            node = f"{prefix}{i}"
            graph.add_node(node, y=lat, x=lng)
            # Normalize orientation, including reversed nearest-edge results.
            if u > v:
                u, v, du, dv = v, u, dv, du
            edges[u, v, key].append((du, node))
            result.append((node, lat, lng, perp))
        outputs.append(result)
    for (u, v, key), points in edges.items():
        attrs = dict(graph.edges[u, v, key])
        length = float(attrs['length'])
        graph.remove_edge(u, v, key)
        chain = [(0.0, u), *sorted(points), (length, v)]
        for (start, a), (end, b) in zip(chain, chain[1:]):
            graph.add_edge(a, b, **{**attrs, 'length': max(0, end - start)})
    return outputs


def shortest_effective(graph, sources, weight):
    """Return cost, physical length and source without storing every full path."""
    serial = itertools.count()
    heap = []
    costs, lengths, origins = {}, {}, {}
    for source in sources:
        costs[source], lengths[source], origins[source] = 0.0, 0.0, source
        heapq.heappush(heap, (0.0, next(serial), source))
    while heap:
        cost, _, u = heapq.heappop(heap)
        if cost != costs[u]:
            continue
        for v, parallel in graph[u].items():
            for edge in parallel.values():
                candidate = cost + edge[weight]
                if candidate < costs.get(v, float('inf')):
                    costs[v] = candidate
                    lengths[v] = lengths[u] + edge['length']
                    origins[v] = origins[u]
                    heapq.heappush(heap, (candidate, next(serial), v))
    return costs, lengths, origins
