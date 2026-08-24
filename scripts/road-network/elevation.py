"""
国土地理院の標高タイルAPI（基盤地図情報数値標高モデル DEM5A のタイル配信版）から
任意の緯度経度の標高を取得するユーティリティ。

XMLメッシュ配布形式ではなく https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt の
タイルAPIを使う（256x256のCSVグリッド、1行1テキストレスポンス）。z=15が5mメッシュの解像度に近い。
DEM5Aは都市部中心の整備のため、データが無いマス目は"e"（空）になることがあり、その場合は
近傍の有効なセルから最近傍探索してフォールバックする。

タイル単位でディスクキャッシュする（同じタイルへの重い再ダウンロードを避けるため。
北部エリア全体でも高々数十タイル程度に収まる想定）。
"""

import math
from pathlib import Path

import requests

CACHE_DIR = Path(__file__).parent / "cache" / "dem5a"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
ZOOM = 15
TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt"


def _lonlat_to_tile_float(lon: float, lat: float, z: int):
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


class ElevationProvider:
    def __init__(self):
        self._tile_cache: dict[tuple[int, int], list[list[float | None]] | None] = {}

    def _load_tile(self, x: int, y: int):
        key = (x, y)
        if key in self._tile_cache:
            return self._tile_cache[key]

        cache_file = CACHE_DIR / f"{ZOOM}_{x}_{y}.txt"
        if cache_file.exists():
            text = cache_file.read_text()
        else:
            url = TILE_URL.format(z=ZOOM, x=x, y=y)
            resp = requests.get(url, timeout=15)
            if resp.status_code != 200:
                self._tile_cache[key] = None
                cache_file.write_text("")  # 404も含めてキャッシュ（同じタイルに何度も404を出さない）
                return None
            text = resp.text
            cache_file.write_text(text)

        if not text.strip():
            self._tile_cache[key] = None
            return None

        grid: list[list[float | None]] = []
        for line in text.strip().split("\n"):
            row = [None if cell == "e" else float(cell) for cell in line.split(",")]
            grid.append(row)
        self._tile_cache[key] = grid
        return grid

    def get_elevation(self, lat: float, lng: float) -> float | None:
        fx, fy = _lonlat_to_tile_float(lng, lat, ZOOM)
        tile_x, tile_y = int(fx), int(fy)
        grid = self._load_tile(tile_x, tile_y)
        if grid is None:
            return None

        px = int((fx - tile_x) * 256)
        py = int((fy - tile_y) * 256)
        px = min(max(px, 0), 255)
        py = min(max(py, 0), 255)

        val = grid[py][px]
        if val is not None:
            return val

        # データ欠測セル（"e"）の場合、周辺の同タイル内を同心円状に探索して最も近い有効値を使う
        # （建物・道路が海岸線や崖際にある稀なケースへの単純なフォールバック）。
        for radius in range(1, 20):
            for dy in range(-radius, radius + 1):
                for dx in range(-radius, radius + 1):
                    ny, nx = py + dy, px + dx
                    if 0 <= ny < 256 and 0 <= nx < 256:
                        v = grid[ny][nx]
                        if v is not None:
                            return v
        return None
