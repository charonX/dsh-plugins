/**
 * DSH official design tokens for System Dashboard.
 * All colors bind to `--dsw-alias-*` so light/dark modes stay consistent.
 *
 * @module @charonx/dsh-system-dashboard/client/tokens
 */

import type React from 'react'

export const COLORS = {
  bgBase: 'var(--dsw-alias-bg-base, #ffffff)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3, #f1f5f9)',
  text: 'var(--dsw-alias-label-primary, #111827)',
  secondary: 'var(--dsw-alias-label-secondary, #4b5563)',
  tertiary: 'var(--dsw-alias-label-tertiary, #9ca3af)',
  brand: 'var(--dsw-alias-brand-primary, #2563eb)',
  onBrand: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  borderSubtle: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.05))',
  border: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
  borderInput: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.14))',
  borderStrong: 'var(--dsw-alias-border-l4, rgba(0,0,0,0.2))',
  error: 'var(--dsw-alias-state-error-primary, #ef4444)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  success: 'var(--dsw-alias-state-success-primary, #10b981)',
  hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))',
  radiusSm: 'var(--dsw-radius-sm, 6px)',
  radiusMd: 'var(--dsw-radius-md, 8px)',
  radiusLg: 'var(--dsw-radius-lg, 12px)',
  shadowPanel: 'var(--dsw-elevation-panel, none)',
} as const

export const cardStyle: React.CSSProperties = {
  background: COLORS.bgLayer2,
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: COLORS.radiusLg,
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  minWidth: 0,
}

export const subCardStyle: React.CSSProperties = {
  background: COLORS.bgLayer1,
  border: `0.5px solid ${COLORS.borderSubtle}`,
  borderRadius: COLORS.radiusMd,
  padding: '10px 12px',
  minWidth: 0,
}

export const buttonStyle: React.CSSProperties = {
  border: `0.5px solid ${COLORS.borderInput}`,
  borderRadius: COLORS.radiusMd,
  background: COLORS.bgLayer2,
  color: COLORS.text,
  padding: '6px 12px',
  fontSize: '12px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  whiteSpace: 'nowrap',
}

export const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: COLORS.brand,
  borderColor: COLORS.brand,
  color: COLORS.onBrand,
  fontWeight: 600,
}

export const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: '32px',
  padding: '0 10px',
  border: `0.5px solid ${COLORS.borderInput}`,
  borderRadius: COLORS.radiusMd,
  background: COLORS.bgLayer1,
  color: COLORS.text,
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
}

export const monoStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontVariantNumeric: 'tabular-nums',
}
