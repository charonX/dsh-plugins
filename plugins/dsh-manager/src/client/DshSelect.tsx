/**
 * DSH `<Menu>`-backed select control shared across manager pages.
 *
 * Replaces raw `<select>` elements so trigger chrome and the portaled dropdown
 * list follow the Host shell's translucent menu surface and `--dsw-alias-*` tokens.
 */

import { useState, type ReactElement } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DshSelect.module.css'

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
  readonly className?: string
}

/**
 * Render a DSH-native dropdown backed by `<Menu portal>`.
 * @param props - current value, option list, and optional trigger class/id.
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
  className,
}: DshSelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  const selected = options.find(opt => opt.value === value)
  const displayLabel = selected?.label ?? placeholder ?? value
  const items: MenuEntry[] = options.map(opt => ({
    id: opt.value,
    label: opt.label,
    ...(opt.disabled ? { disabled: true } : {}),
  }))

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
      className={css.menuRoot}
      anchor={(
        <button
          id={id}
          type="button"
          className={className ? `${css.trigger} ${className}` : css.trigger}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          data-select-control=""
          data-value={value}
          onClick={() => {
            if (!disabled) setOpen(prev => !prev)
          }}
        >
          <span className={selected === undefined && placeholder !== undefined ? `${css.label} ${css.placeholder}` : css.label}>
            {displayLabel}
          </span>
          <span className={css.chevron} data-open={open && !disabled ? 'true' : 'false'} aria-hidden="true">
            <IconChevronDownOutlineRegular size={12} />
          </span>
        </button>
      )}
    />
  )
}
