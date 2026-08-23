import type { NextConfig } from "next";
import CopyWebpackPlugin from "copy-webpack-plugin";
import TerserPlugin from "terser-webpack-plugin";
import path from "path";
import webpack from "webpack";

const cesiumSource = path.join(
  path.dirname(require.resolve("cesium/package.json")),
  "Build",
  "Cesium"
);

// 相対パスだと next dev / next build で出力先(output.path)が異なり
// コピー先がずれて 404 になるため、プロジェクトルート基準の絶対パスを使う
// （plateau-poc プロジェクトで踏んだ落とし穴。詳細はAGENTS.md参照）
const publicCesiumDir = path.join(process.cwd(), "public", "cesium");

const nextConfig: NextConfig = {
  // スマホ実機からLAN経由で `next dev` の開発サーバーにアクセスして確認するための設定。
  // 家庭内LANでよく使われる192.168.0.0/16・10.0.0.0/8をカバーしておく
  // （実際のLAN IPは環境によって変わるため、必要に応じて自分の環境のIPを追記する）。
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],

  // Next.js開発モードの丸いインジケーター（左下に常時表示）を無効化。
  // 画面4隅すべてを自前のUIパネル（Legend/InfoPopup/UncoloredBuildingsNote/
  // CoverageStatsPanel）が占有しているため、位置を変えても必ずどこかと重なってしまう。
  // 本番ビルド（next build）では元々表示されないため、実質dev時のみの見た目の問題。
  devIndicators: false,

  webpack: (config) => {
    config.plugins = config.plugins || [];
    config.plugins.push(
      new CopyWebpackPlugin({
        patterns: [
          { from: path.join(cesiumSource, "Workers"), to: path.join(publicCesiumDir, "Workers") },
          { from: path.join(cesiumSource, "ThirdParty"), to: path.join(publicCesiumDir, "ThirdParty") },
          { from: path.join(cesiumSource, "Assets"), to: path.join(publicCesiumDir, "Assets") },
          { from: path.join(cesiumSource, "Widgets"), to: path.join(publicCesiumDir, "Widgets") },
        ],
      }),
      new webpack.DefinePlugin({
        CESIUM_BASE_URL: JSON.stringify("/cesium"),
      })
    );

    // 本番ビルド(next build)限定の不具合対策（plateau-pocプロジェクトで発見・解決済み）。
    // `cesium` パッケージの `module`/`browser` エントリは、Cesium自身のビルドで
    // 既に最適化・バンドル済みの成果物（Build/Cesium/index.js）を指している。
    // これをさらにNext.jsの本番ビルド用minifier（Next内蔵のterserラッパー、
    // config.optimization.minimizer に無名関数として仕込まれておりオプション変更不可）で
    // 再minifyすると、CesiumのバンドルにWASMバイナリをレガシーな8進数エスケープ
    // （例: '\0asm\1\0...'）を含む文字列リテラルとして埋め込んだ箇所が、
    // テンプレートリテラルに誤変換されて構文的に不正なコードが生成されることがある
    // （devビルドでは再現せず、Vercel等の本番デプロイでのみ発生する）。
    // → 自前のTerserPluginに差し替え、cesiumパッケージ配下をminify対象から除外する。
    config.optimization = config.optimization || {};
    config.optimization.minimizer = [
      new TerserPlugin({
        exclude: /node_modules[\\/]cesium[\\/]/,
      }),
    ];

    return config;
  },
};

export default nextConfig;
