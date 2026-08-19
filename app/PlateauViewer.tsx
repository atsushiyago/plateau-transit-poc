"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Cesium from "cesium";

// 表示したい自治体コード（14205 = 神奈川県藤沢市）。
// 総務省の全国地方公共団体コード表で他の自治体コードに差し替え可能。
// https://www.soumu.go.jp/denshijiti/code.html
const CITY_CODE = "14205";

// 複合tileset.json API: 自治体コード + "-latest" で最新整備年度のLOD1建物データに自動追従する。
const BUILDING_TILESET_URL = `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${CITY_CODE}-bldg-lod1-latest/tileset.json`;

// PLATEAU-Terrain（Cesium ionトークン不要で利用可能）
// 注意: layer.json は https://tile.plateauview.mlit.go.jp/terrain/layer.json にあり、
// ベースURLは "/terrain" まで（オルソ画像のような年度サフィックスは付かない）
const TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain";

// PLATEAU-Ortho（航空写真オルソ画像。こちらもionトークン不要）
// Cesium.Viewer はデフォルトでCesium ion経由の衛星画像を背景に使おうとするため、
// ionトークンを設定しない場合はここを明示的に差し替えないとレンダリングが止まる。
const ORTHO_URL = "https://tile.plateauview.mlit.go.jp/tiles/plateau-ortho-2023/{z}/{x}/{y}.png";

// バス停データ（藤沢市北部、JR東海道線より北側のみ）。
// 神奈川中央交通のGTFS-JPは「公共交通オープンデータチャレンジ2026」限定ライセンスの
// APIキーが必要で、そのチャレンジの申込期間（2026年10月1日〜）がまだ開始していないため、
// 代わりにOpenStreetMap（Overpass API、highway=bus_stop等）から抽出したデータを暫定的に使っている。
// 事業者名の付いていないノードも多いため`operator`を絶対視せず、エリア内の全バス停として扱う。
// 10月以降にGTFS-JPの正式データが取得できるようになったら差し替える想定（詳細はAGENTS.md参照）。
const BUS_STOPS_JSON_URL = "/data/bus-stops.json";

const BUS_STOP_COLOR = Cesium.Color.fromCssColorString("#f59e0b");
const BUS_STOP_PIXEL_SIZE = 10;

type BusStop = { name: string; lat: number; lng: number; operator?: string | null };

type PopupInfo = { title: string; lines: ReactNode[] };

// Cesium標準のinfoBox/selectionIndicatorは無効化している（下記Viewer初期化オプション参照）ため、
// バス停クリック時の情報表示はこの自前ポップアップで行う。
function InfoPopup({ info, onClose }: { info: PopupInfo; onClose: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        right: 12,
        top: 12,
        zIndex: 10,
        background: "rgba(20, 20, 20, 0.85)",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: 6,
        fontSize: 13,
        lineHeight: 1.6,
        fontFamily: "sans-serif",
        maxWidth: 280,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: "bold" }}>{info.title}</div>
        <button
          onClick={onClose}
          aria-label="閉じる"
          style={{
            background: "none",
            border: "none",
            color: "#fff",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      {info.lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

export default function PlateauViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [popup, setPopup] = useState<PopupInfo | null>(null);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    let cancelled = false;

    async function init() {
      let terrainProvider: Cesium.TerrainProvider;
      try {
        terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL);
      } catch (err) {
        console.error("PLATEAU-Terrainの読み込みに失敗しました。平坦な地形で継続します。", err);
        terrainProvider = new Cesium.EllipsoidTerrainProvider();
      }
      if (cancelled || !containerRef.current) return;

      const viewer = new Cesium.Viewer(containerRef.current, {
        terrainProvider,
        // Cesium ionのデフォルト背景画像を使わず、PLATEAU-Ortho（ion不要）を使う
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(
          Promise.resolve(
            new Cesium.UrlTemplateImageryProvider({
              url: ORTHO_URL,
              credit: "Project PLATEAU (国土交通省)",
              maximumLevel: 19,
            })
          ),
          {}
        ),
        // 開発中に不要なUIを削って画面を広く使う。必要に応じて有効化する。
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        animation: false,
        timeline: false,
        // 独自のバス停ポップアップUIと、Cesium標準のinfoBox/selectionIndicatorが
        // 競合しないよう最初から無効化している（plateau-pocで発生した問題の再発防止）。
        infoBox: false,
        selectionIndicator: false,
      });
      viewerRef.current = viewer;

      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(BUILDING_TILESET_URL);
        if (cancelled) return;
        viewer.scene.primitives.add(tileset);
      } catch (err) {
        console.error("PLATEAU 建物3D Tilesの読み込みに失敗しました", err);
      }

      // PLATEAU-Orthoは藤沢市北部エリアで一部タイルが404になり抜けがある
      // （江の島周辺を扱うplateau-pocでは発生しなかった。おそらくオルソ画像の
      // モザイク範囲がエリアによって粗密差がある）。Cesiumのデフォルト地表色（青、
      // 一見「海」に見えて紛らわしい）ではなく中立なグレーにして、抜けを「データなし」と
      // 分かるようにしておく。
      viewer.scene.globe.baseColor = Cesium.Color.DARKSLATEGRAY;

      // バス停をピンで表示する。ラベルは付けず、クリックで名称をポップアップ表示する
      // （653件と数が多く、常時ラベル表示すると密集地でズームアウト時に重なりすぎるため）。
      const busStopPositions: Cesium.Cartesian3[] = [];
      try {
        const res = await fetch(BUS_STOPS_JSON_URL);
        const data: { busStops: BusStop[] } = await res.json();
        if (cancelled) return;
        for (const stop of data.busStops) {
          const position = Cesium.Cartesian3.fromDegrees(stop.lng, stop.lat);
          busStopPositions.push(position);
          viewer.entities.add({
            name: stop.name,
            position,
            properties: { isBusStop: true, operator: stop.operator ?? null },
            point: {
              pixelSize: BUS_STOP_PIXEL_SIZE,
              color: BUS_STOP_COLOR,
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
        }
      } catch (err) {
        console.error("バス停データの読み込みに失敗しました", err);
      }

      // Cesium標準のクリック選択（selectionIndicator/infoBox）は無効化しているため、
      // バス停クリック時の情報表示は自前のInfoPopupで行う。
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        const picked = viewer.scene.pick(movement.position);
        const entity = picked?.id;
        if (entity instanceof Cesium.Entity && entity.properties?.isBusStop?.getValue()) {
          const operator = entity.properties.operator?.getValue();
          setPopup({
            title: entity.name ?? "バス停",
            lines: operator ? [`事業者: ${operator}`] : ["事業者情報なし（OSMデータ）"],
          });
        } else {
          setPopup(null);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      // カメラはバス停ピン全体に自動フィットする。viewer.flyTo(entities, ...)は
      // 地形解決待ちでハングすることがあるため使わず（plateau-pocで発覚した問題の再発防止）、
      // 生の頂点座標からBoundingSphereを自前計算してflyToBoundingSphereで移動する。
      if (busStopPositions.length > 0) {
        const sphere = Cesium.BoundingSphere.fromPoints(busStopPositions);
        viewer.camera.flyToBoundingSphere(sphere, {
          offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(-30), 0),
        });
      }
    }

    init();

    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {popup && <InfoPopup info={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}
