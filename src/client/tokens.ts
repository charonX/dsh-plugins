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

/**
 * Text input: the Models page's own `.input` recipe (32px row, l4 border,
 * layer-1 fill). Textareas reuse it with an explicit height.
 */
export const inputStyle = {
  boxSizing: 'border-box',
  width: '100%',
  height: 32,
  padding: '0 10px',
  border: `0.5px solid ${COLORS.borderInput}`,
  borderRadius: COLORS.radiusMd,
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  background: COLORS.layer1,
  color: COLORS.text,
} as const

/**
 * Select: the page's `.input` + `.selectInput` pair — the native control is
 * hidden and the page's own chevron is painted 12px from the right edge, which
 * is what makes a plugin select look like the page's select.
 */
export const selectStyle = {
  ...inputStyle,
  appearance: 'none' as const,
  paddingRight: 32,
  cursor: 'pointer',
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat' as const,
  backgroundPosition: 'right 12px center',
  backgroundSize: '12px 12px',
} as const

/** Form row: label above control, the page's 6px gap. */
export const fieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginBottom: 14,
} as const

/** Field label: the page's 12/18 medium secondary. */
export const labelStyle = {
  fontSize: 12,
  lineHeight: '18px',
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

/** One route group on the model page. */
export const groupStyle = {
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: COLORS.radiusLg,
  background: COLORS.layer1,
  padding: '12px 14px',
  marginBottom: 14,
} as const

/** Group heading row: one line, separated from the models below by a rule. */
export const groupHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap' as const,
  paddingBottom: 10,
  borderBottom: `0.5px solid ${COLORS.border}`,
} as const

/** Group title. */
export const groupTitleStyle = {
  margin: 0,
  fontSize: 14,
  lineHeight: '22px',
  fontWeight: 500,
  color: COLORS.text,
} as const

/** Page heading. */
export const pageTitleStyle = {
  margin: 0,
  fontSize: 16,
  lineHeight: '24px',
  fontWeight: 500,
  color: COLORS.text,
} as const

/** Models container: indented under the route header with a containment rail. */
export const modelListStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  marginTop: 10,
  paddingLeft: 12,
  borderLeft: `2px solid ${COLORS.border}`,
} as const

/** One model row inside a group. */
export const modelRowStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 8,
  padding: '8px 0',
  borderTop: `0.5px solid ${COLORS.border}`,
} as const

/** First model row carries no rule: the header already ends with one. */
export const firstModelRowStyle = {
  ...modelRowStyle,
  borderTop: 'none',
} as const

/** The override editor, further indented so it clearly belongs to its model. */
export const overridePanelStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 0,
  marginTop: 4,
  paddingLeft: 12,
  borderLeft: `2px solid ${COLORS.borderStrong}`,
} as const

/** Row meta text (capacity, levels). */
export const metaStyle = {
  fontSize: 12,
  color: COLORS.tertiary,
} as const

/** Model name in a row. */
export const modelNameStyle = {
  fontSize: 13,
  fontWeight: 500,
  color: COLORS.text,
} as const

/** Fixed-width row action so buttons line up down the list. */
export const rowActionStyle = {
  ...quietButtonStyleBase(),
  minWidth: 88,
  height: 28,
  padding: '0 10px',
  borderRadius: COLORS.radiusSm,
  fontSize: 12,
  lineHeight: '18px',
  marginLeft: 'auto',
  flex: 'none',
} as const

/** Base geometry shared by the row action (declared before use above). */
function quietButtonStyleBase() {
  return {
    boxSizing: 'border-box' as const,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    border: `0.5px solid ${COLORS.borderInput}`,
    background: 'transparent',
    color: COLORS.text,
    font: 'inherit',
    cursor: 'pointer',
  }
}

/** Row summary line. */
export const modelSummaryStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap' as const,
} as const

/** Monospaced identifier. */
export const codeStyle = {
  fontFamily: 'monospace',
  fontSize: 12,
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
