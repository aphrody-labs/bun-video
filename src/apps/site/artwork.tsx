import React from "react";
import { Easing, interpolate, spring } from "../../../remotion/core/src/index";
import type { ShowcaseWork } from "./collection";

/** A pure frame function shared by previews and the registered Remotion composition. */
export function Artwork({ work, frame }: { work: ShowcaseWork; frame: number }) {
  const t = frame / (work.fps.num / work.fps.den);
  const background = "var(--md-sys-color-surface)";
  const accent = "var(--md-sys-color-primary)";
  const light = "var(--md-sys-color-on-surface)";
  const secondary = "var(--md-sys-color-secondary)";
  const reveal = interpolate(frame, [0, 28], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const bounce = spring({ frame, fps: work.fps.num / work.fps.den, config: { damping: 18, stiffness: 90 } });
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1280 720"
      width="100%"
      height="100%"
      role="img"
      aria-label={work.title}
    >
      <defs>
        <radialGradient id="orb">
          <stop stopColor={light} />
          <stop offset="0.18" stopColor={accent} />
          <stop offset="0.7" stopColor={background} />
          <stop offset="1" stopColor="var(--md-sys-color-surface-container-lowest)" />
        </radialGradient>
        <linearGradient id="line">
          <stop stopColor={accent} stopOpacity="0" />
          <stop offset="0.5" stopColor={light} />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1280" height="720" fill={background} />
      {work.artwork === "orbit" && (
        <g transform={`translate(640 355) rotate(${t * 8})`}>
          <circle r="206" fill="url(#orb)" />
          {Array.from({ length: 24 }, (_, i) => (
            <ellipse
              key={i}
              rx={250 + i * 8}
              ry={42 + i * 3}
              fill="none"
              stroke={i % 3 ? accent : light}
              strokeOpacity={0.18 + (i % 4) * 0.12}
              strokeWidth={i % 5 === 0 ? 2 : 0.7}
              transform={`rotate(${i * 7 + t * 12})`}
            />
          ))}
          {Array.from({ length: 180 }, (_, i) => {
            const angle = i * 2.399963 + t * 0.3;
            const radius = 210 + (i % 37) * 7;
            return (
              <circle
                key={i}
                cx={Math.cos(angle) * radius}
                cy={Math.sin(angle) * radius * 0.55}
                r={i % 4 === 0 ? 2 : 1}
                fill={i % 3 ? light : secondary}
                opacity={0.25 + (i % 5) * 0.14}
              />
            );
          })}
        </g>
      )}
      {work.artwork === "type" && (
        <g
          fill={accent}
          fontFamily="Showcase, Arial, sans-serif"
          fontWeight="900"
          fontSize="156"
          letterSpacing="-10"
          transform={`translate(${(1 - bounce) * 180} 0) skewY(-8)`}
          opacity={reveal}
        >
          <text x="72" y="335">
            MOUV
          </text>
          <text x="220" y="505">
            EMENT
          </text>
          <path d={`M70 540h${650 * reveal}l-55 45H70z`} fill={light} />
        </g>
      )}
      {work.artwork === "terrain" && (
        <g fill="none" stroke={light}>
          {Array.from({ length: 60 }, (_, row) => (
            <path
              key={row}
              strokeOpacity={0.14 + row / 100}
              strokeWidth="1"
              d={Array.from({ length: 81 }, (_, x) => {
                const px = x * 16;
                const py = 70 + row * 11 + Math.sin(x / 8 + row / 9 + t) * (32 + Math.sin(x / 21) * 60);
                return `${x ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`;
              }).join(" ")}
            />
          ))}
        </g>
      )}
      {work.artwork === "wave" && (
        <g stroke={accent}>
          {Array.from({ length: 120 }, (_, i) => {
            const amplitude = (Math.sin(i * 0.37 + t * 2) ** 2 * 0.6 + Math.cos(i * 0.13 - t) ** 2 * 0.4) * 220;
            return (
              <line
                key={i}
                x1={45 + i * 10}
                x2={45 + i * 10}
                y1={360 - amplitude}
                y2={360 + amplitude}
                strokeWidth={i % 3 === 0 ? 3 : 1}
                opacity={0.3 + (i % 5) * 0.13}
              />
            );
          })}
          <path d={`M0 360H1280`} stroke={light} strokeWidth="1" />
        </g>
      )}
      {work.artwork === "grid" && (
        <g>
          {Array.from({ length: 48 }, (_, i) => {
            const x = i % 8,
              y = Math.floor(i / 8);
            const phase = Math.sin(t * 1.5 - x * 0.4 - y * 0.3);
            return (
              <rect
                key={i}
                x={80 + x * 144}
                y={48 + y * 108}
                width="112"
                height="76"
                rx={Math.max(0, phase * 36)}
                fill={i % 3 === 0 ? light : accent}
                opacity={0.3 + (phase + 1) * 0.3}
                transform={`rotate(${phase * 18} ${136 + x * 144} ${86 + y * 108})`}
              />
            );
          })}
        </g>
      )}
      {work.artwork === "bloom" && (
        <g transform={`translate(640 360) rotate(${t * 16})`}>
          {Array.from({ length: 36 }, (_, i) => (
            <ellipse
              key={i}
              rx={120 + Math.sin(t + i / 9) * 32}
              ry="260"
              fill="none"
              stroke={i % 3 === 0 ? light : accent}
              strokeOpacity="0.6"
              strokeWidth="1.3"
              transform={`rotate(${i * 10}) translate(${Math.sin(t) * 20} 0)`}
            />
          ))}
        </g>
      )}
      {work.features.length > 0 && (
        <g opacity={reveal}>
          <rect
            x="48"
            y="48"
            width="850"
            height="154"
            rx="16"
            fill={background}
            fillOpacity="0.94"
            stroke={accent}
            strokeOpacity="0.5"
          />
          <text x="72" y="78" fill={light} fontSize="14" fontFamily="monospace">
            BUN VIDEO · MATERIAL 3
          </text>
          <text x="72" y="124" fill={light} fontSize="27" fontFamily="Showcase, Arial, sans-serif" fontWeight="700">
            {work.title}
          </text>
          <text x="72" y="168" fill={light} fontSize="14" fontFamily="monospace">
            {work.features.slice(0, 4).join(" · ").toUpperCase()}
          </text>
        </g>
      )}
      <path d="M48 660H1232" stroke={light} strokeOpacity="0.3" />
      <g fill={light} fontFamily="Showcase, Arial, sans-serif" fontSize="15" letterSpacing="3">
        <text x="48" y="694">
          BUN VIDEO / {work.artwork.toUpperCase()}
        </text>
        <text x="1060" y="694">
          {String(frame).padStart(4, "0")} / {String(work.durationFrames).padStart(4, "0")}
        </text>
      </g>
    </svg>
  );
}
