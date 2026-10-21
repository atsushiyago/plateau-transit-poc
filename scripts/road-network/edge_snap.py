"""
建物・バス停・駅を、最寄りの道路網「ノード」ではなく最寄りの道路網「エッジ上の点」に
スナップするためのユーティリティ。

【改善の経緯】当初はox.distance.nearest_nodesで最寄りノードにスナップしていたが、
停留所からわずか15〜50m（直線距離）しか離れていない建物で、経路距離が400〜800mに
達するケースが見つかった。原因は、最寄りノード（交差点）が実際にはもっと離れた場所に
あることがあるため（例えば道路の途中に立つ建物は、両端の交差点までの距離の方が
道路上の最寄り点までの距離より大きい）。エッジ（道路そのもの）上の最寄り点に
垂線を下ろしてスナップすることで、この問題を解消する。

手法: 標準的な「エッジへの投影＋仮想ノード挿入」方式。
1. グラフをUTM（メートル単位の投影座標系）に変換する（ox.distance.nearest_edgesは
   「正確な結果を得るには投影されたグラフ・投影された点を使うこと」を推奨している）
2. 各点についてox.distance.nearest_edges（Rツリー空間索引によるベクトル化検索）で
   最寄りのエッジ(u, v, key)を求める
3. 投影点を返す。呼び出し側は全点をまとめてrouting.split_snap_groupsに渡し、
   道路を投影点の順に分割して接続する（同一道路上の点同士が迂回しないため）。
"""

from __future__ import annotations

import math

import networkx as nx
import numpy as np
import osmnx as ox
import pyproj


class EdgeSnapper:
    def __init__(self, G_undirected: nx.MultiGraph):
        self.G = G_undirected
        self.G_proj = ox.project_graph(G_undirected)
        crs = self.G_proj.graph["crs"]
        self._to_proj = pyproj.Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self._to_wgs84 = pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

        # 各ノードの投影座標をNumPy配列としてキャッシュ（射影計算をベクトル化するため）。
        self._node_ids = list(self.G_proj.nodes)
        self._node_xy = {
            n: (d["x"], d["y"]) for n, d in self.G_proj.nodes(data=True)
        }

    def snap_batch(self, lats: list[float], lngs: list[float]):
        """
        建物・バス停等の(lat, lng)配列を一括でエッジスナップする。
        戻り値: [(u, v, key, snap_lat, snap_lng, dist_to_u_m, dist_to_v_m, perp_dist_m), ...]
        """
        xs_wgs84 = lngs
        ys_wgs84 = lats
        xs_proj, ys_proj = self._to_proj.transform(xs_wgs84, ys_wgs84)

        nearest = ox.distance.nearest_edges(self.G_proj, xs_proj, ys_proj)
        # nearest_edgesは点が1つならタプル、複数ならNumPy配列を返す。常に配列として扱う。
        if isinstance(nearest, tuple):
            nearest = np.array([nearest])

        results = []
        for i, (u, v, key) in enumerate(nearest):
            u, v, key = int(u), int(v), int(key)
            px, py = xs_proj[i], ys_proj[i]
            ux, uy = self._node_xy[u]
            vx, vy = self._node_xy[v]

            edge_dx, edge_dy = vx - ux, vy - uy
            edge_len_sq = edge_dx * edge_dx + edge_dy * edge_dy
            if edge_len_sq < 1e-9:
                t = 0.0
            else:
                t = ((px - ux) * edge_dx + (py - uy) * edge_dy) / edge_len_sq
                t = min(max(t, 0.0), 1.0)

            snap_x = ux + t * edge_dx
            snap_y = uy + t * edge_dy

            # エッジの実長（'length'属性、道路の実際の長さ）をtで按分する。
            # simplify=Falseで取得したグラフなので、エッジはほぼ直線とみなせ、
            # 按分は実距離とほぼ一致する。
            edge_data = self.G.get_edge_data(u, v)
            edge_length = None
            if edge_data and key in edge_data:
                edge_length = edge_data[key].get("length")
            if edge_length is None:
                edge_length = math.sqrt(edge_len_sq)

            dist_to_u = t * edge_length
            dist_to_v = (1 - t) * edge_length
            perp_dist = math.hypot(px - snap_x, py - snap_y)

            snap_lng, snap_lat = self._to_wgs84.transform(snap_x, snap_y)
            results.append((u, v, key, snap_lat, snap_lng, dist_to_u, dist_to_v, perp_dist))

        return results
