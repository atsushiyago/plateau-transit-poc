"use client";

import React, { useEffect } from "react";

interface SlopeCalculationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SlopeCalculationModal({ isOpen, onClose }: SlopeCalculationModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "rgba(15, 23, 42, 0.96)",
          color: "#e2e8f0",
          border: "1px solid rgba(56, 189, 248, 0.3)",
          borderRadius: 10,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05)",
          width: "100%",
          maxWidth: 640,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          fontFamily: "sans-serif",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        {/* ヘッダー */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "rgba(30, 41, 59, 0.5)",
            borderTopLeftRadius: 10,
            borderTopRightRadius: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>ℹ️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: "bold", color: "#f8fafc" }}>
                勾配・歩行速度プロファイルの計算のしくみ
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>
                実効歩行距離の算出ロジックと各係数の役割（藤沢市北部モデル）
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="閉じる"
            style={{
              background: "rgba(255, 255, 255, 0.1)",
              border: "none",
              color: "#cbd5e1",
              fontSize: 16,
              width: 28,
              height: 28,
              borderRadius: 6,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.15s ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255, 255, 255, 0.2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)")}
          >
            ✕
          </button>
        </div>

        {/* 本文（スクロール可能） */}
        <div style={{ padding: "16px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 概要 */}
          <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: 6, padding: "10px 14px", color: "#e0f2fe", fontSize: 12.5 }}>
            本システムでは、単なる平面直線距離ではなく、地形の標高差（勾配）や歩行者の体力特性を考慮して「実際の体感負担（実効歩行距離）」を推計しています。2つの主要係数はそれぞれ<strong>「誰が歩くか（人の体力差）」</strong>と<strong>「上り・下りと地域の過酷さ」</strong>という異なる役割を担っています。
          </div>

          {/* 1. 一言でいうと（表） */}
          <div>
            <div style={{ fontWeight: "bold", color: "#38bdf8", marginBottom: 6, fontSize: 13 }}>
              ■ 2つの係数の役割
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, background: "rgba(15, 23, 42, 0.4)", borderRadius: 6, overflow: "hidden" }}>
              <thead>
                <tr style={{ background: "rgba(30, 41, 59, 0.8)", borderBottom: "1px solid rgba(255, 255, 255, 0.1)" }}>
                  <th style={{ padding: "8px 10px", textAlign: "left", width: "30%", color: "#cbd5e1" }}>係数</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", width: "25%", color: "#cbd5e1" }}>役割</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", color: "#cbd5e1" }}>何を表しているか</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.06)" }}>
                  <td style={{ padding: "8px 10px", fontWeight: "bold", color: "#f1f5f9" }}>① 勾配ペナルティ係数</td>
                  <td style={{ padding: "8px 10px", color: "#7dd3fc" }}>「人の体力差」</td>
                  <td style={{ padding: "8px 10px", color: "#cbd5e1" }}>
                    坂の斜度（キツさ）にどれだけ敏感か<br />
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>
                      （運動生理学の知見※に基づき、登坂時のエネルギー消費・筋力負荷が一般成人の約2倍となる身体特性を反映）
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "8px 10px", fontWeight: "bold", color: "#f1f5f9" }}>② 上り坂の割増倍率</td>
                  <td style={{ padding: "8px 10px", color: "#7dd3fc" }}>「上り・下りと地域の過酷さ」</td>
                  <td style={{ padding: "8px 10px", color: "#cbd5e1" }}>
                    下り坂と比べ、上り坂をどれだけ重くみるか<br />
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>（重力に逆らう上り坂や団地特有の坂道に対する割増）</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 4, lineHeight: 1.4 }}>
              ※運動生理学・リハビリテーション分野等の研究において、高齢者の坂道登坂時のエネルギー消費（METs）や身体負荷は若年成人の約1.8〜2.2倍に跳ね上がることが示されている知見を参考に設定。
            </div>
          </div>

          {/* 2. 計算式 */}
          <div>
            <div style={{ fontWeight: "bold", color: "#38bdf8", marginBottom: 6, fontSize: 13 }}>
              ■ 計算式での使われ方
            </div>
            <div
              style={{
                background: "rgba(0, 0, 0, 0.35)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
                borderRadius: 6,
                padding: "12px 14px",
                fontFamily: "monospace",
                fontSize: 12.5,
                color: "#e2e8f0",
                lineHeight: 1.8,
              }}
            >
              <div>
                実効歩行距離 = 水平距離 × <span style={{ color: "#f8fafc", fontWeight: "bold" }}>[ 1 + (① 勾配ペナルティ係数) × (② 方向割増倍率) × 斜度(勾配) ]</span>
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, fontFamily: "sans-serif" }}>
                ※上り坂では ②上り坂倍率（1.25倍）、下り坂では下り倍率（1.0倍）を適用。<br />
                ※極端な崖による過大推計を防ぐため、斜度は最大40%（0.40）で上限キャップを設けています。
              </div>
            </div>
          </div>

          {/* 3. 藤沢市での設定値と具体例 */}
          <div>
            <div style={{ fontWeight: "bold", color: "#38bdf8", marginBottom: 6, fontSize: 13 }}>
              ■ 藤沢市北部の設定値と具体例（斜度10%の坂を100m登る場合）
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* 一般成人 */}
              <div style={{ background: "rgba(30, 41, 59, 0.6)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontWeight: "bold", color: "#93c5fd", marginBottom: 4 }}>
                  一般（標準の坂道補正）
                </div>
                <div style={{ fontSize: 11.5, color: "#cbd5e1" }}>
                  ・勾配ペナルティ: <strong>3.0</strong><br />
                  ・上り坂割増: <strong>1.25倍</strong><br />
                  ・基準歩行速度: <strong>67m/分</strong>（分速80mの約84%）
                </div>
                <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid rgba(255, 255, 255, 0.08)", fontSize: 12 }}>
                  <div style={{ color: "#94a3b8", fontSize: 11 }}>100m登ったときの実効距離:</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#cbd5e1", marginTop: 2 }}>
                    100m × (1 + 3.0 × 1.25 × 0.10)
                  </div>
                  <div style={{ fontWeight: "bold", color: "#38bdf8", fontSize: 14 }}>
                    = 約138m
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>平地と比べて約1.38倍の距離負担</div>
                </div>
              </div>

              {/* 高齢者 */}
              <div style={{ background: "rgba(30, 41, 59, 0.6)", border: "1px solid rgba(245, 158, 11, 0.2)", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontWeight: "bold", color: "#fcd34d", marginBottom: 4 }}>
                  高齢者（坂道の負荷係数2倍）
                </div>
                <div style={{ fontSize: 11.5, color: "#cbd5e1" }}>
                  ・勾配ペナルティ: <strong>6.0</strong>（一般の2倍）<br />
                  ・上り坂割増: <strong>1.25倍</strong><br />
                  ・基準歩行速度: <strong>50m/分</strong>
                </div>
                <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid rgba(255, 255, 255, 0.08)", fontSize: 12 }}>
                  <div style={{ color: "#94a3b8", fontSize: 11 }}>100m登ったときの実効距離:</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#cbd5e1", marginTop: 2 }}>
                    100m × (1 + 6.0 × 1.25 × 0.10)
                  </div>
                  <div style={{ fontWeight: "bold", color: "#fbbf24", fontSize: 14 }}>
                    = 約175m
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>平地と比べて約1.75倍の距離負担</div>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>
              ※湘南大庭や遠藤地区など、丘陵地に造成された住宅団地における坂道移動の実態（徒歩困難度）に即した判定を行っています。
            </div>
          </div>
        </div>

        {/* フッター */}
        <div
          style={{
            padding: "10px 18px",
            borderTop: "1px solid rgba(255, 255, 255, 0.1)",
            display: "flex",
            justifyContent: "flex-end",
            background: "rgba(30, 41, 59, 0.4)",
            borderBottomLeftRadius: 10,
            borderBottomRightRadius: 10,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "rgba(56, 189, 248, 0.2)",
              border: "1px solid rgba(56, 189, 248, 0.5)",
              borderRadius: 4,
              color: "#38bdf8",
              fontSize: 12,
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
