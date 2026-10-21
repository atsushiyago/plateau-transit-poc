"""Reproduce analysis facility inputs, without clipping them to the study boundary.

Usage: python 00_extract_facilities.py /path/P11-22_14_GML.zip /path/N02-22_GML.zip
Downloads (2022 editions):
https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_14_GML.zip
https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-22/N02-22_GML.zip
Keep existing OSM coordinates for the five original stations; add surrounding
N02 station representatives (centres of platform lines, not entrance points).
"""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from shapely.geometry import shape

DATA = Path(__file__).resolve().parents[2] / 'public/data'
# Matches cached pedestrian network extent; includes facilities south of the
# Tokaido line and in neighbouring cities. Study buildings are unchanged.
BBOX = (139.39,35.32,139.52,35.44)
def inside(lat,lng):
    return BBOX[0] <= lng <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]

def main():
    z=zipfile.ZipFile(sys.argv[1]); root=ET.fromstring(z.read('P11-22_14_GML/P11-22_14.xml'))
    ns={'g':'http://schemas.opengis.net/gml/3.2.1','k':'http://nlftp.mlit.go.jp/ksj/schemas/ksj-app','x':'http://www.w3.org/1999/xlink'}
    points={p.attrib['{'+ns['g']+'}id']:list(map(float,p.find('g:pos',ns).text.split())) for p in root.findall('g:Point',ns)}
    stops=[]
    for s in root.findall('k:BusStop',ns):
        lat,lng=points[s.find('k:loc',ns).attrib['{'+ns['x']+'}href'].lstrip('#')]
        if inside(lat,lng):
            stops.append(dict(name=s.findtext('k:bsn',namespaces=ns),operator=s.findtext('k:boc',namespaces=ns),lat=lat,lng=lng,
                routes=[dict(name=r.findtext('k:brn',namespaces=ns),classCode=r.findtext('k:brt',namespaces=ns)) for r in s.findall('k:bri',ns)]))
    stations=json.loads((DATA/'train-stations.json').read_text())['stations']
    original={s['name'].removesuffix('駅') for s in stations}
    grouped={}
    z=zipfile.ZipFile(sys.argv[2]); features=json.loads(z.read('UTF-8/N02-22_Station.geojson'))['features']
    for f in features:
        p=shape(f['geometry']).centroid; name=f['properties']['N02_005']
        if inside(p.y,p.x) and name not in original:
            grouped.setdefault(name,[]).append((p.y,p.x))
    for name,coords in sorted(grouped.items()):
        stations.append(dict(name=name+'駅',lat=sum(p[0] for p in coords)/len(coords),lng=sum(p[1] for p in coords)/len(coords)))
    output={'bbox':BBOX,'sources':['国土数値情報 P11 2022年度','国土数値情報 N02 2022年度（追加駅のホーム形状重心）','OpenStreetMap（既存5駅）'],
        'busStops':stops,'stations':stations}
    (DATA/'analysis-facilities.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(f'{len(stops)} stops, {len(stations)} stations:',[s['name'] for s in stations])
if __name__=='__main__':main()
