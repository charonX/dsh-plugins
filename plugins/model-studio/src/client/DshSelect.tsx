/**
 * DSH `<Menu>`-backed select control for model-studio compatibility forms.
 *
 * @module dsh-model-studio/client/DshSelect
 */

import { useState, type CSSProperties, type ReactElement } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { COLORS } from './tokens.ts'

export interface DshSelectOption {
  readonly value: string
  readonly label: string
}

export interface DshSelectProps {
  readonly id?: string
  readonly value: string
  readonly options: readonly DshSelectOption[]
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly style?: CSSProperties
}

const STYLE_ID = 'dsh-ms-select-styles'

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
    .dsh-ms-menu-full {
      display: flex;
      width: 100%;
    }
    .dsh-ms-select-btn {
      box-sizing: border-box;
      width: 100%;
      height: 32px;
      padding: 0 10px;
      border: 0.5px solid ${COLORS.borderInput};
      border-radius: ${COLORS.radiusMd};
      font: inherit;
      font-size: 14px;
      line-height: 22px;
      background: ${COLORS.layer1};
      color: ${COLORS.text};
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      outline: none;
      text-align: left;
      transition: border-color 140ms ease;
    }
    .dsh-ms-select-btn:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .dsh-ms-select-btn:focus-visible {
      outline: var(--dsw-focus-ring-width, 1.5px) solid var(--dsw-focus-ring-color, ${COLORS.brand});
      outline-offset: -1px;
    }
  `
  document.head.appendChild(el)
}

/** Render a DSH `<Menu portal>` dropdown for form fields. */
export function DshSelect({ id, value, options, onChange, disabled = false, style }: DshSelectProps): ReactElement {
  ensureStyles()
  const [open, setOpen] = useState(false)
  const selected = options.find(opt => opt.value === value)
  const items: MenuEntry[] = options.map(opt => ({ id: opt.value, label: opt.label }))

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
      minWidthFromAnchor
      className="dsh-ms-menu-full"
      anchor={(
        <button
          id={id}
          type="button"
          className="dsh-ms-select-btn"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          onClick={() => {
            if (!disabled) setOpen(prev => !prev)
          }}
          style={style}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {selected?.label ?? value}
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
