"use client";

import dynamic from "next/dynamic";

// CesiumはブラウザAPI（window等）に依存するためSSRを無効化して読み込む
const PlateauViewer = dynamic(() => import("./PlateauViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      読み込み中...
    </div>
  ),
});

export default function Home() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <PlateauViewer />
    </div>
  );
}
