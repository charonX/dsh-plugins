/**
 * DSH design tokens used by this plugin's surfaces.
 *
 * Every value resolves through a Host alias so light and dark themes switch
 * together, and each carries a neutral fallback for a Host that renames one.
 *
 * @module dsh-immersive-translate/client/tokens
 */

/** Host design tokens plus the shared inline style fragments. */
export const COLORS = {
  layer1: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
  layer2: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  layer3: 'var(--dsw-alias-bg-layer-3, #f1f5f9)',
  text: 'var(--dsw-alias-label-primary, #111827)',
  secondary: 'var(--dsw-alias-label-secondary, #4b5563)',
  tertiary: 'var(--dsw-alias-label-tertiary, #6b7280)',
  brand: 'var(--dsw-alias-brand-primary, #2563eb)',
  onBrand: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
  radiusSm: 'var(--dsw-radius-sm, 6px)',
  radiusMd: 'var(--dsw-radius-md, 8px)',
  radiusLg: 'var(--dsw-radius-lg, 12px)',
  panelShadow: 'var(--dsw-elevation-panel)',
  overlayShadow: 'var(--dsw-elevation-overlay)',
} as const

/** Text input shared by the panel and the settings page. */
export const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  font: 'inherit',
  fontSize: 13,
  color: COLORS.text,
  background: COLORS.layer1,
  border: `0.5px solid ${COLORS.borderStrong}`,
  borderRadius: COLORS.radiusSm,
  outline: 'none',
} as const

/** Primary action button. */
export const primaryButtonStyle = {
  padding: '6px 12px',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  color: COLORS.onBrand,
  background: COLORS.brand,
  border: 'none',
  borderRadius: COLORS.radiusSm,
  cursor: 'pointer',
} as const

/** Secondary action button. */
export const quietButtonStyle = {
  ...primaryButtonStyle,
  color: COLORS.text,
  background: COLORS.layer3,
  border: `0.5px solid ${COLORS.border}`,
} as const
