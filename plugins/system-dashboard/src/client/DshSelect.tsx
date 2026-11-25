/**
 * DSH `<Menu>`-backed select control for System Dashboard settings.
 *
 * @module @charonx/dsh-system-dashboard/client/DshSelect
 */

import { useState, type ReactElement } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { COLORS } from './tokens.ts'

export interface DshSelectOption {
  readonly value: string
  readonly label: string
}

export interface DshSelectProps {
  readonly value: string
  readonly options: readonly DshSelectOption[]
  readonly onChange: (value: string) => void
  readonly ariaLabel?: string
}

const STYLE_ID = 'dsh-sd-select-styles'

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
    .dsh-sd-menu-full {
      display: flex;
      width: 100%;
    }
    .dsh-sd-select-btn {
      box-sizing: border-box;
      width: 100%;
      height: 32px;
      padding: 0 10px;
      border: 0.5px solid ${COLORS.borderInput};
      border-radius: ${COLORS.radiusMd};
      background: ${COLORS.bgLayer1};
      color: ${COLORS.text};
      font-size: 13px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      outline: none;
      text-align: left;
      transition: border-color 140ms ease;
    }
    .dsh-sd-select-btn:hover {
      border-color: ${COLORS.borderStrong};
    }
    .dsh-sd-select-btn:focus-visible {
      outline: var(--dsw-focus-ring-width, 1.5px) solid var(--dsw-focus-ring-color, ${COLORS.brand});
      outline-offset: -1px;
    }
  `
  document.head.appendChild(el)
}

/** Render a DSH `<Menu portal>` dropdown matching System Dashboard form inputs. */
export function DshSelect({ value, options, onChange, ariaLabel }: DshSelectProps): ReactElement {
  ensureStyles()
  const [open, setOpen] = useState(false)
  const selected = options.find(opt => opt.value === value)
  const items: MenuEntry[] = options.map(opt => ({ id: opt.value, label: opt.label }))

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedId={value}
      onSelect={(next) => {
        onChange(next)
        setOpen(false)
      }}
      portal
      minWidthFromAnchor
      className="dsh-sd-menu-full"
      anchor={(
        <button
          type="button"
          className="dsh-sd-select-btn"
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(prev => !prev) }}
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
              transform: open ? 'rotate(180deg)' : 'none',
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
