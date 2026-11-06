/**
 * DSH design tokens used by this plugin's two extension areas.
 *
 * Every colour resolves through a Host alias so light and dark themes switch
 * together; the neutral fallbacks only matter for a Host that renames a token.
 * No surface may introduce its own palette.
 *
 * @module dsh-model-studio/client/tokens
 */

/** Host design tokens plus shared inline style fragments. */
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
  borderInput: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.18))',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
  radiusSm: 'var(--dsw-radius-sm, 6px)',
  radiusMd: 'var(--dsw-radius-md, 8px)',
  radiusLg: 'var(--dsw-radius-lg, 12px)',
} as const

/** Separator + ownership label row shared by both extension areas. */
export const frameStyle = {
  marginTop: 12,
  paddingTop: 10,
  borderTop: `0.5px solid ${COLORS.border}`,
} as const

/** Collapsed disclosure header. */
export const summaryStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  listStyle: 'none',
  fontSize: 13,
  fontWeight: 500,
  color: COLORS.text,
} as const

/** The `扩展 · <owner>` marker that keeps plugin content distinguishable. */
export const badgeStyle = {
  fontSize: 11,
  fontWeight: 400,
  letterSpacing: 0.2,
  color: COLORS.tertiary,
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: COLORS.radiusSm,
  padding: '1px 6px',
} as const

/** Body container: recessed inside a provider card, raised on the settings page. */
export function bodyStyle(surface: 'raised' | 'recessed') {
  return {
    marginTop: 10,
    padding: 10,
    background: surface === 'raised' ? COLORS.layer2 : COLORS.layer1,
    border: `0.5px solid ${COLORS.border}`,
    borderRadius: COLORS.radiusMd,
  } as const
}

/** Supporting copy line. */
export const hintStyle = {
  margin: '4px 0 0',
  fontSize: 12,
  lineHeight: 1.5,
  color: COLORS.tertiary,
} as const

/** Failure copy line. */
export const errorStyle = {
  ...hintStyle,
  color: COLORS.error,
} as const

/** Success copy line. */
export const noticeStyle = {
  ...hintStyle,
  color: COLORS.secondary,
} as const

/** Text input and textarea. */
export const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  font: 'inherit',
  fontSize: 13,
  color: COLORS.text,
  background: COLORS.layer2,
  border: `0.5px solid ${COLORS.borderInput}`,
  borderRadius: COLORS.radiusSm,
} as const

/** Select control. */
export const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
} as const

/** Form row: label above control. */
export const fieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 10,
} as const

/** Field label. */
export const labelStyle = {
  fontSize: 12,
  fontWeight: 500,
  color: COLORS.secondary,
} as const

/** Shared control geometry: the Models page's own button base (36px row). */
const controlBase = {
  boxSizing: 'border-box' as const,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  height: 36,
  padding: '0 14px',
  border: 'none',
  borderRadius: COLORS.radiusMd,
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  cursor: 'pointer',
} as const

/** Primary action button (the page's filled variant). */
export const primaryButtonStyle = {
  ...controlBase,
  background: 'var(--dsw-alias-button-primary-fill, #2563eb)',
  color: COLORS.onBrand,
} as const

/** Secondary action button (the page's outlined variant). */
export const quietButtonStyle = {
  ...controlBase,
  border: `0.5px solid ${COLORS.borderInput}`,
  background: 'transparent',
  color: COLORS.text,
} as const

/**
 * The trigger that sits where the page's own "add provider" control sits: same
 * row, same corner, dashed because it is the last slot of the provider list
 * rather than a command in a footer.
 */
export const addButtonStyle = {
  ...controlBase,
  flex: '1 1 0',
  minWidth: 180,
  gap: 6,
  height: 44,
  border: `1px dashed ${COLORS.borderInput}`,
  borderRadius: COLORS.radiusLg,
  background: 'transparent',
  color: COLORS.text,
} as const

/** Row that holds the trigger; matches the page's own add-action row. */
export const addActionsStyle = {
  display: 'flex',
} as const

/** Full-viewport layer, matching the page's dialog shell. */
export const dialogRootStyle = {
  position: 'fixed' as const,
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
} as const

/** The dimming layer behind a dialog. */
export const dialogMaskStyle = {
  position: 'absolute' as const,
  inset: 0,
  background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32))',
  backdropFilter: 'var(--dsw-mask-blur)',
} as const

/** Dialog card: full-height column that caps against the layer's padding box. */
export const dialogStyle = {
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 20,
  width: 'min(560px, 100%)',
  maxHeight: '100%',
  padding: '0 0 24px',
  overflow: 'hidden',
  border: 0,
  borderRadius: 'var(--dsw-radius-panel, 12px)',
  background: COLORS.layer2,
  boxShadow: 'var(--dsw-elevation-prominent)',
} as const

/** Dialog header row. */
export const dialogHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '22px 14px 12px 24px',
} as const

/** Dialog title. */
export const dialogTitleStyle = {
  margin: 0,
  fontSize: 16,
  lineHeight: '24px',
  fontWeight: 500,
  color: COLORS.text,
} as const

/** Dialog close button. */
export const dialogCloseStyle = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: COLORS.radiusSm,
  background: 'transparent',
  color: COLORS.secondary,
  cursor: 'pointer',
  fontSize: 16,
} as const

/** Scrollable dialog body. */
export const dialogBodyStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  minWidth: 0,
  marginTop: 20,
  padding: '0 24px',
  overflowY: 'auto' as const,
} as const

/** Dialog action row. */
export const dialogFooterStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '0 24px',
} as const

/** One row of a selectable list. */
export const rowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  padding: '6px 8px',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left' as const,
  color: COLORS.text,
  background: 'transparent',
  border: `0.5px solid transparent`,
  borderRadius: COLORS.radiusSm,
  cursor: 'pointer',
} as const

/** Selected or hovered row. */
export const selectedRowStyle = {
  ...rowStyle,
  background: COLORS.layer3,
  border: `0.5px solid ${COLORS.borderStrong}`,
} as const

/** Scrollable list container. */
export const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 320,
  overflowY: 'auto' as const,
  marginTop: 8,
  padding: 2,
} as const

/** Muted secondary line inside a row. */
export const rowHintStyle = {
  fontSize: 11,
  color: COLORS.tertiary,
  overflowWrap: 'anywhere' as const,
} as const

/** Key/value detail table. */
export const keyValueStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(96px, auto) 1fr',
  gap: '4px 10px',
  margin: '8px 0 0',
  fontSize: 12,
} as const

/** Key cell of the detail table. */
export const keyStyle = {
  color: COLORS.tertiary,
} as const

/** Value cell of the detail table. */
export const valueStyle = {
  color: COLORS.secondary,
  overflowWrap: 'anywhere' as const,
} as const

/** Inline action row. */
export const actionsStyle = {
  display: 'flex',
  gap: 8,
  marginTop: 12,
  alignItems: 'center',
} as const
