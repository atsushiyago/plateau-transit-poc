"""Generate consistent network scores and the graph used to evaluate new stops.

All facilities/buildings are snapped in one pass and each road is split in order.
Access edges and slope costs participate in shortest-path selection itself.
"""
import argparse
import hashlib
import json
from pathlib import Path
import osmnx as ox
from edge_snap import EdgeSnapper
from elevation import ElevationProvider
from routing import split_snap_groups, shortest_effective

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DATA = REPO_ROOT / 'public/data'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int)
    parser.add_argument('--buildings-file', default=str(SCRIPT_DIR / 'buildings.json'))
    parser.add_argument('--output', default=str(DATA / 'building-network-scores.json'))
    args = parser.parse_args()
    buildings = json.loads(Path(args.buildings_file).read_text())
    if args.limit:
        buildings = buildings[:args.limit]
    stops = [s for s in json.loads((DATA/'analysis-facilities.json').read_text())['busStops'] if '神奈川中央交通' in s['operator']]
    stations = json.loads((DATA/'analysis-facilities.json').read_text())['stations']
    graph = ox.load_graphml(SCRIPT_DIR/'road_network.graphml').to_undirected()
    snapper = EdgeSnapper(graph)
    groups = [buildings, stops, stations]
    print('Snapping and splitting roads', flush=True)
    snapped = [snapper.snap_batch([p['lat'] for p in group], [p['lng'] for p in group]) for group in groups]
    virtual = split_snap_groups(graph, list(zip(['bldg::','bus::','sta::'], snapped)))
    for _, _, edge in graph.edges(data=True):
        edge['road'] = 1
    # Terminal access edges cannot serve as shortcuts through private property.
    for prefix, group, nodes in zip(['building','stop','station'], groups, virtual):
        for i, (p, (node, _, _, perp)) in enumerate(zip(group, nodes)):
            actual = f'{prefix}:{i}'
            graph.add_node(actual, x=p['lng'], y=p['lat'])
            graph.add_edge(actual, node, length=perp, road=0)
    elevation = ElevationProvider()
    missing = 0
    print('Sampling node elevations', flush=True)
    for _, node in graph.nodes(data=True):
        height = elevation.get_elevation(node['y'], node['x'])
        node['height'] = height
        missing += height is None
    # Missing elevations are explicit; do not manufacture sea-level cliffs.
    for u, v, edge in graph.edges(data=True):
        a, b = graph.nodes[u]['height'], graph.nodes[v]['height']
        length = edge['length']
        gradient = min(abs(a-b)/max(length, 1), .4) if a is not None and b is not None else 0
        for profile, factor in [('general',3), ('elderly',6)]:
            edge[profile] = length*(1+factor*gradient)
    node_ids = {node:i for i,node in enumerate(graph)}
    rows = [{**b, 'networkNode':node_ids[f'building:{i}']} for i,b in enumerate(buildings)]
    for side, prefix, facilities in [('bus','stop',stops), ('station','station',stations)]:
        sources = [f'{prefix}:{i}' for i in range(len(facilities))]
        names = {source:facilities[i]['name'] for i,source in enumerate(sources)}
        for profile in ['general','elderly']:
            print(f'Routing {side}/{profile}', flush=True)
            costs, lengths, origins = shortest_effective(graph, sources, profile)
            for i,row in enumerate(rows):
                node = f'building:{i}'
                if node not in costs:
                    raise ValueError(f'Unreachable building: {row["buildingId"]}')
                row[f'{side}EffectiveDistanceM_{profile}'] = round(costs[node], 3)
                row[f'{side}NetworkDistanceM_{profile}'] = round(lengths[node], 3)
                row[f'nearest{ "Stop" if side=="bus" else "Station"}Name_{profile}'] = names[origins[node]]
                if profile == 'general':
                    row[f'{side}NetworkDistanceM'] = round(lengths[node], 3)
                    row[f'nearest{ "Stop" if side=="bus" else "Station"}Name'] = names[origins[node]]
    for row in rows:
        for profile in ['general','elderly']:
            ratio = min(row[f'busEffectiveDistanceM_{profile}']/300,row[f'stationEffectiveDistanceM_{profile}']/600)
            row[f'coverageRatio_{profile}'] = ratio
            row[f'isCovered_{profile}'] = ratio <= 1
    nodes = [[n['x'],n['y'],n['height']] for _,n in graph.nodes(data=True)]
    edges = [[node_ids[u],node_ids[v],e['length'],e['general'],e['elderly'],e['road']] for u,v,e in graph.edges(data=True)]
    serialized = json.dumps(rows, ensure_ascii=False, separators=(',',':'))
    version = hashlib.sha256(serialized.encode()).hexdigest()[:16]
    output = Path(args.output)
    # Graph and scores share an id; the client rejects mismatched assets.
    for row in rows:
        row['datasetVersion'] = version
    output.with_name('routing-graph.json').write_text(json.dumps({'version':version,'nodes':nodes,'edges':edges,'missingElevationNodes':missing},separators=(',',':')))
    temp = output.with_suffix('.tmp')
    temp.write_text(json.dumps(rows,ensure_ascii=False,separators=(',',':')))
    temp.replace(output)
    print(f'Wrote {len(rows)} rows, {len(nodes)} nodes; missing elevations: {missing}; version {version}',flush=True)

if __name__ == '__main__':
    main()
