import { NextResponse } from "next/server";

// OpenStreetMap Nominatimの逆ジオコーディングAPIへのサーバーサイドプロキシ。
// クライアントから直接叩くとレート制限（Nominatimの利用ポリシーは1リクエスト/秒程度）に
// 引っかかりやすいのと、識別可能なUser-Agentの送出が利用規約で必須なため、
// plateau-poc の /api/route と同様にサーバー側でプロキシする構成にしている。
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// Nominatimは応答が遅いことがあるため、フォールバック判断のためにタイムアウトを設ける。
const NOMINATIM_TIMEOUT_MS = 8000;

// Nominatim利用規約で必須の識別可能なUser-Agent。
const NOMINATIM_USER_AGENT =
  "plateau-transit-poc/1.0 (PLATEAU CityHack Challenge 2026 PoC; contact: atsushiyago@gmail.com)";

type NominatimAddress = {
  neighbourhood?: string;
  suburb?: string;
  quarter?: string;
  city_district?: string;
  town?: string;
  village?: string;
  city?: string;
};

type NominatimResponse = {
  address?: NominatimAddress;
  display_name?: string;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!lat || !lng || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return NextResponse.json({ error: "lat and lng query params are required" }, { status: 400 });
  }

  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latNum));
  url.searchParams.set("lon", String(lngNum));
  // zoom=16は住宅地レベル（neighbourhood/suburb相当）の粒度を狙った設定。
  // 高すぎると道路名まで、低すぎると市区町村までしか返らない。
  url.searchParams.set("zoom", "16");
  url.searchParams.set("accept-language", "ja");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": NOMINATIM_USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      // Nominatim側のレート制限・一時的な不調はハンドリング済みの失敗として扱う
      // （呼び出し側のクライアントがフォールバック表示をするため console.error ではなく warn）。
      console.warn("Nominatim reverse geocode returned non-OK status", res.status, await res.text());
      return NextResponse.json({ error: "reverse geocode request failed" }, { status: 502 });
    }

    const data: NominatimResponse = await res.json();
    const address = data.address ?? {};
    // 「推定地区名」として使うのに一番粒度が良い順に優先する。
    const areaName =
      address.neighbourhood ??
      address.suburb ??
      address.quarter ??
      address.city_district ??
      address.town ??
      address.village ??
      address.city ??
      null;

    return NextResponse.json({ areaName, displayName: data.display_name ?? null });
  } catch (err) {
    console.warn("Nominatim reverse geocodeへのリクエストに失敗しました", err);
    return NextResponse.json({ error: "reverse geocode request failed" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
