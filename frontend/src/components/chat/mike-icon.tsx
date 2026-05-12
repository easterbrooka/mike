"use client";

import React from "react";

// Ellen "Bloom — Stamen" mark.
//   8 line filaments around a centre disc, each terminating in a tip dot.
//   Palette tokens: charcoal #2B2E33 ink, WRMK orange #E8742C accent.
//   Component name is preserved as MikeIcon to avoid touching 10 call sites.

const ORANGE = "#E8742C";
const INK = "#2B2E33";

const DONE_INK = "#16A34A";
const DONE_ACCENT = "#22C55E";

const ERROR_INK = "#DC2626";
const ERROR_ACCENT = "#EF4444";

const PETALS = 8;
const INNER_R = 7;
const OUTER_R = 14.5;
const STROKE_W = 2.25;
const CENTER_R = 3.75;
const TIP_DOT_R = 1.6;
const ROTATION_DEG = -90;

const CX = 24;
const CY = 24;

type Palette = { ink: string; accent: string };

const DEFAULT_PALETTE: Palette = { ink: INK, accent: ORANGE };
const DONE_PALETTE: Palette = { ink: DONE_INK, accent: DONE_ACCENT };
const ERROR_PALETTE: Palette = { ink: ERROR_INK, accent: ERROR_ACCENT };

interface PetalGeometry {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

const PETAL_GEOMETRY: PetalGeometry[] = Array.from(
    { length: PETALS },
    (_, i) => {
        const a =
            (i / PETALS) * Math.PI * 2 + (ROTATION_DEG * Math.PI) / 180;
        return {
            x1: CX + Math.cos(a) * INNER_R,
            y1: CY + Math.sin(a) * INNER_R,
            x2: CX + Math.cos(a) * OUTER_R,
            y2: CY + Math.sin(a) * OUTER_R,
        };
    }
);

export function MikeIcon({
    spin = false,
    done = false,
    error = false,
    mike = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    mike?: boolean;
    size?: number;
    style?: React.CSSProperties;
}) {
    void mike;
    const palette = error
        ? ERROR_PALETTE
        : done
          ? DONE_PALETTE
          : DEFAULT_PALETTE;

    return (
        <span
            className="shrink-0 inline-block"
            style={{ lineHeight: 0, ...style }}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 48 48"
                width={size}
                height={size}
                style={{ display: "block" }}
            >
                {spin && (
                    <style>{`@keyframes mikeIconBloomWave{0%,100%{opacity:.3}30%{opacity:1}}`}</style>
                )}
                {PETAL_GEOMETRY.map(({ x1, y1, x2, y2 }, i) => {
                    const petalStyle: React.CSSProperties | undefined = spin
                        ? {
                              animation: `mikeIconBloomWave 0.8s ease-in-out ${(i * 0.1).toFixed(1)}s infinite`,
                          }
                        : undefined;
                    return (
                        <g key={i} style={petalStyle}>
                            <line
                                x1={x1}
                                y1={y1}
                                x2={x2}
                                y2={y2}
                                stroke={palette.ink}
                                strokeWidth={STROKE_W}
                                strokeLinecap="round"
                            />
                            <circle
                                cx={x2}
                                cy={y2}
                                r={TIP_DOT_R}
                                fill={palette.ink}
                            />
                        </g>
                    );
                })}
                <circle
                    cx={CX}
                    cy={CY}
                    r={CENTER_R}
                    fill={palette.accent}
                />
            </svg>
        </span>
    );
}
