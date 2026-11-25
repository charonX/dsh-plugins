/**
 * DSH `<Menu>`-backed select control shared across immersive-translate surfaces.
 *
 * Replaces native `<select>` elements so trigger chrome, chevron icon, and the
 * portaled translucent menu match DSH's design tokens and dark/light modes.
 *
 * @module dsh-immersive-translate/client/DshSelect
 */

import { useState, type CSSProperties, type ReactElement } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { COLORS } from './tokens.ts'

export interface DshSelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface DshSelectProps {
  readonly id?: string
  readonly value: string
  readonly options: readonly DshSelectOption[]
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly ariaLabel?: string
  readonly variant?: 'form' | 'compact'
  readonly align?: 'start' | 'end'
  readonly side?: 'bottom' | 'top'
  readonly style?: CSSProperties
}

const STYLE_ID = 'dsh-it-select-styles'

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
    .dsh-it-menu-full {
      display: flex;
      width: 100%;
    }
    .dsh-it-select-btn {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font: inherit;
      cursor: pointer;
      outline: none;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .dsh-it-select-btn:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    .dsh-it-select-btn[data-variant='form']:not(:disabled):hover {
      border-color: ${COLORS.borderStrong};
    }
    .dsh-it-select-btn[data-variant='compact']:not(:disabled):hover {
      background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
      color: ${COLORS.text};
    }
    .dsh-it-select-btn:focus-visible {
      outline: var(--dsw-focus-ring-width, 1.5px) solid var(--dsw-focus-ring-color, ${COLORS.brand});
      outline-offset: -1px;
    }
  `
  document.head.appendChild(el)
}

/**
 * Render a DSH-native dropdown backed by `<Menu portal>`.
 * @param props - current value, option list, and appearance variant.
 * @returns the trigger + portaled DSH menu.
 */
export function DshSelect({
  id,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  ariaLabel,
  variant = 'form',
  align = 'start',
  side = 'bottom',
  style,
}: DshSelectProps): ReactElement {
  ensureStyles()
  const [open, setOpen] = useState(false)
  const selected = options.find(opt => opt.value === value)
  const displayLabel = selected?.label ?? placeholder ?? value

  const items: MenuEntry[] = options.map(opt => ({
    id: opt.value,
    label: opt.label,
    ...(opt.disabled ? { disabled: true } : {}),
  }))

  const isCompact = variant === 'compact'
  const isFullWidth = style?.width === '100%' || (variant === 'form' && style?.width === undefined)
  const triggerStyle: CSSProperties = isCompact
    ? {
        height: 28,
        padding: '0 8px',
        border: 'none',
        borderRadius: COLORS.radiusSm,
        background: 'transparent',
        color: COLORS.secondary,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '20px',
        ...style,
      }
    : {
        width: isFullWidth ? '100%' : undefined,
        height: 32,
        padding: '0 10px',
        border: `0.5px solid ${COLORS.borderStrong}`,
        borderRadius: COLORS.radiusMd,
        background: COLORS.layer1,
        color: selected !== undefined ? COLORS.text : COLORS.tertiary,
        fontSize: 13,
        lineHeight: '20px',
        ...style,
      }

  return (
    <Menu
      open={open && !disabled}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedId={value}
      onSelect={(next) => {
        onChange(next)
        setOpen(false)
      }}
      portal
      minWidthFromAnchor={!isCompact}
      compact={isCompact}
      align={align}
      side={side}
      className={isFullWidth ? 'dsh-it-menu-full' : undefined}
      anchor={(
        <button
          id={id}
          type="button"
          className="dsh-it-select-btn"
          data-variant={variant}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          onClick={() => {
            if (!disabled) setOpen(prev => !prev)
          }}
          style={triggerStyle}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {displayLabel}
          </span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: COLORS.tertiary,
              transform: open && !disabled ? 'rotate(180deg)' : 'none',
              transition: 'transform 140ms ease',
            }}
          >
            <IconChevronDownOutlineRegular size={12} />
          </span>
        </button>
      )}
    />
  )
}
