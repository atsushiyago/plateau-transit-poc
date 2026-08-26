"""
藤沢市の建物3D Tiles（LOD1）を再帰的に走査し、.b3dmのバッチテーブルを直接パースして
住宅系建物（bldg:usageに「住宅」を含む）かつ藤沢市北部（東海道線より北）の建物一覧を抽出する。

app/PlateauViewer.tsx がクライアント側でCesium3DTileFeature.getProperty()経由でやっているのと
全く同じデータ取得を、オフラインでPythonから直接やる（AGENTS.mdに「実際に.b3dmのバッチテーブル
バイナリをPythonでパースして_x/_yが正しい経緯度を返すことを確認済み」とある通り、このプロジェクトでは
既に一度検証済みの手法）。

出力: buildings.json（このディレクトリ内、.gitignore対象。最終成果物はpublic/data/に別途出力する）
"""

import json
import struct
import sys
from pathlib import Path

import requests

ROOT_TILESET_URL = "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/14205-bldg-lod1-latest/tileset.json"
RESIDENTIAL_USAGE_SUBSTRING = "住宅"

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
TOKAIDO_LINE_JSON = REPO_ROOT / "public" / "data" / "tokaido-line.json"
OUTPUT_JSON = SCRIPT_DIR / "buildings.json"


def line_lat_at_lon(points, lon):
    # isNorthOfTokaidoLine（app/PlateauViewer.tsx）と同じロジック。
    if lon <= points[0][0]:
        return points[0][1]
    if lon >= points[-1][0]:
        return points[-1][1]
    for i in range(len(points) - 1):
        lon1, lat1 = points[i]
        lon2, lat2 = points[i + 1]
        if lon1 <= lon <= lon2:
            if lon2 == lon1:
                return (lat1 + lat2) / 2
            t = (lon - lon1) / (lon2 - lon1)
            return lat1 + t * (lat2 - lat1)
    return points[-1][1]


def is_north_of_tokaido_line(points, lng, lat):
    if not points:
        return False
    return lat > line_lat_at_lon(points, lng)


def collect_content_uris(tile_node, out):
    content = tile_node.get("content")
    if content and "uri" in content:
        out.append(content["uri"])
    for child in tile_node.get("children", []):
        collect_content_uris(child, out)


def parse_b3dm_batch_table(data: bytes):
    magic = data[0:4]
    if magic != b"b3dm":
        raise ValueError(f"not a b3dm file (magic={magic!r})")
    _version, _byte_length = struct.unpack("<II", data[4:12])
    ft_json_len, ft_bin_len, bt_json_len, bt_bin_len = struct.unpack("<IIII", data[12:28])

    offset = 28
    offset += ft_json_len + ft_bin_len
    bt_json = json.loads(data[offset : offset + bt_json_len]) if bt_json_len else {}
    offset += bt_json_len
    bt_bin = data[offset : offset + bt_bin_len]

    # BATCH_LENGTHはFeature Table JSONにあるが、bldg:usage等のインライン配列の長さからも分かる。
    # インライン配列を優先して使う（無ければ0件扱い）。
    usage_list = bt_json.get("bldg:usage", [])
    n = len(usage_list)

    def read_double_array(key):
        ref = bt_json.get(key)
        if ref is None:
            return [None] * n
        if isinstance(ref, list):
            return ref
        # {byteOffset, componentType: DOUBLE, type: SCALAR} 形式（_x, _y等）
        byte_offset = ref["byteOffset"]
        return list(struct.unpack(f"<{n}d", bt_bin[byte_offset : byte_offset + n * 8]))

    def read_inline(key):
        val = bt_json.get(key, [None] * n)
        return val if isinstance(val, list) else [None] * n

    xs = read_double_array("_x")
    ys = read_double_array("_y")
    building_ids = read_inline("uro:BuildingIDAttribute_uro:buildingID")
    floor_areas = read_inline("uro:BuildingDetailAttribute_uro:totalFloorArea")

    rows = []
    for i in range(n):
        rows.append(
            {
                "usage": usage_list[i],
                "lng": xs[i],
                "lat": ys[i],
                "buildingId": building_ids[i] or f"{xs[i]},{ys[i]}",
                "totalFloorArea": floor_areas[i],
            }
        )
    return rows


def main():
    tokaido_points = json.loads(TOKAIDO_LINE_JSON.read_text())["points"]

    print("ルートtileset.jsonを取得中...", file=sys.stderr)
    root = requests.get(ROOT_TILESET_URL, timeout=30).json()
    child_uri = root["root"]["children"][0]["content"]["uri"]
    base_url = child_uri.rsplit("/", 1)[0] + "/"

    print(f"子tileset.jsonを取得中... ({child_uri})", file=sys.stderr)
    child = requests.get(child_uri, timeout=30).json()

    content_uris = []
    collect_content_uris(child["root"], content_uris)
    print(f"タイル数: {len(content_uris)}", file=sys.stderr)

    session = requests.Session()
    all_residential_north = []
    total_buildings = 0

    for idx, uri in enumerate(content_uris):
        url = uri if uri.startswith("http") else base_url + uri
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
            rows = parse_b3dm_batch_table(resp.content)
        except Exception as e:  # noqa: BLE001
            print(f"  [警告] {url} の取得/パースに失敗: {e}", file=sys.stderr)
            continue

        total_buildings += len(rows)
        for row in rows:
            usage = row["usage"] or ""
            if RESIDENTIAL_USAGE_SUBSTRING not in usage:
                continue
            if row["lng"] is None or row["lat"] is None:
                continue
            if not is_north_of_tokaido_line(tokaido_points, row["lng"], row["lat"]):
                continue
            all_residential_north.append(row)

        if (idx + 1) % 50 == 0 or idx == len(content_uris) - 1:
            print(
                f"  {idx + 1}/{len(content_uris)} タイル処理済み "
                f"(全建物 {total_buildings} 件中、住宅系×北部 {len(all_residential_north)} 件)",
                file=sys.stderr,
            )

    # 同じ建物が複数タイルに重複して現れることがあるため、buildingIdで重複排除する
    # （3D Tilesの空間分割の都合上、境界付近の建物が親子タイル両方に含まれることがある）。
    dedup = {row["buildingId"]: row for row in all_residential_north}
    result = list(dedup.values())
    print(
        f"重複排除後: {len(result)} 件（重複排除前 {len(all_residential_north)} 件）",
        file=sys.stderr,
    )

    OUTPUT_JSON.write_text(json.dumps(result, ensure_ascii=False))
    print(f"書き出し完了: {OUTPUT_JSON}", file=sys.stderr)


if __name__ == "__main__":
    main()
