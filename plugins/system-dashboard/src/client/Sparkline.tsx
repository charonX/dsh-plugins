/**
 * Lightweight pure-SVG dual-series telemetry chart using DSH design tokens.
 *
 * @module @charonx/dsh-system-dashboard/client/Sparkline
 */

import type { ReactElement } from 'react'
import { COLORS, monoStyle } from './tokens.ts'

export interface ChartSeries {
  readonly label: string
  readonly color: string
  readonly values: readonly number[]
}

export interface DualSparklineProps {
  readonly series: readonly ChartSeries[]
  readonly maxY?: number
  readonly formatValue: (v: number) => string
  readonly emptyLabel: string
  readonly height?: number
}

export function DualSparkline({
  series,
  maxY,
  formatValue,
  emptyLabel,
  height = 128,
}: DualSparklineProps): ReactElement {
  const width = 480
  const padTop = 8
  const padBottom = 10
  const plotHeight = height - padTop - padBottom

  const allValues = series.flatMap(s => s.values)
  const hasPoints = series.some(s => s.values.length >= 2)

  if (!hasPoints) {
    return (
      <div
        style={{
          height: `${height}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: COLORS.tertiary,
          fontSize: '12px',
          background: COLORS.bgLayer1,
          borderRadius: COLORS.radiusMd,
        }}
      >
        {emptyLabel}
      </div>
    )
  }

  const computedMax = maxY ?? Math.max(1, ...allValues) * 1.15

  const buildPath = (values: readonly number[]): string => {
    const n = values.length
    if (n === 0) return ''
    if (n === 1) {
      const y = padTop + plotHeight - ((values[0] ?? 0) / computedMax) * plotHeight
      return `M 0 ${y.toFixed(1)} L ${width} ${y.toFixed(1)}`
    }
    return values
      .map((val, idx) => {
        const x = (idx / (n - 1)) * width
        const clamped = Math.max(0, Math.min(computedMax, val))
        const y = padTop + plotHeight - (clamped / computedMax) * plotHeight
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div
        style={{
          background: COLORS.bgLayer1,
          borderRadius: COLORS.radiusMd,
          padding: '6px 8px',
          border: `0.5px solid ${COLORS.borderSubtle}`,
        }}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: `${height}px`, display: 'block' }}
        >
          {[0.25, 0.5, 0.75].map((ratio) => {
            const y = padTop + plotHeight * ratio
            return (
              <line
                key={ratio}
                x1={0}
                y1={y}
                x2={width}
                y2={y}
                stroke={COLORS.border}
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            )
          })}
          {series.map((s) => (
            <path
              key={s.label}
              d={buildPath(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          {series.map((s) => {
            const latest = s.values.at(-1) ?? 0
            return (
              <span
                key={s.label}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: COLORS.secondary }}
              >
                <span
                  style={{
                    width: '10px',
                    height: '2.5px',
                    borderRadius: '2px',
                    background: s.color,
                    display: 'inline-block',
                  }}
                />
                <span>{s.label}:</span>
                <span style={{ ...monoStyle, color: COLORS.text, fontWeight: 600 }}>
                  {formatValue(latest)}
                </span>
              </span>
            )
          })}
        </div>
        <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary }}>
          max {formatValue(computedMax)}
        </span>
      </div>
    </div>
  )
}
