"""
osmnxで藤沢市北部の歩行可能な道路網を取得し、graphml形式でキャッシュする。

バウンディングボックスは既存のpublic/data/bus-stops.json（P11、Overpass藤沢市境界＋
isNorthOfTokaidoLineで絞り込み済み、337件）の緯度経度の範囲から算出し、多少の余裕を持たせている
（app/api/hellocycling-stations/route.tsのNORTH_FUJISAWA_BBOXと同じ考え方・同じ値）。
"""

import json
import sys
from pathlib import Path

import osmnx as ox

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
OUTPUT_GRAPHML = SCRIPT_DIR / "road_network.graphml"

# app/api/hellocycling-stations/route.ts の NORTH_FUJISAWA_BBOX と同じ値。
NORTH = 35.44
SOUTH = 35.32
EAST = 139.52
WEST = 139.39


def main():
    print("osmnxで道路網を取得中（初回は数十秒かかる）...", file=sys.stderr)
    # simplify=False にしている理由: simplify=Trueだと、複数の実道路セグメントを1本のエッジに
    # まとめてしまい、そのエッジの`length`属性（実際の道のり長、曲線込み）と、ノード間の
    # 直線距離（03_compute_scores.pyの勾配計算で使う区間距離）が食い違ってしまう。
    # 具体的には、簡略化されたエッジのlengthは長いのにノード間の直線距離は短くなるため、
    # 標高差÷区間距離で求める勾配が過大評価され、実効距離が理論上限（1+係数×0.4）を
    # 超えてしまう不具合が実際に発生した。simplify=Falseなら各ノードが元のOSM座標点を
    # すべて保持するため、エッジはほぼ直線とみなせて整合する（グラフは大きくなるが、
    # ダイクストラ法は1回の走査で済むため計算量的には問題にならない）。
    graph = ox.graph_from_bbox((WEST, SOUTH, EAST, NORTH), network_type="walk", simplify=False)
    print(f"nodes={len(graph.nodes)} edges={len(graph.edges)}", file=sys.stderr)
    ox.save_graphml(graph, OUTPUT_GRAPHML)
    print(f"書き出し完了: {OUTPUT_GRAPHML}", file=sys.stderr)


if __name__ == "__main__":
    main()
