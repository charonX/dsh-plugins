/** Input / textarea wrapper offering DSH-tokenized `/` slash command autocomplete. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentSlashCommand } from '../crew/wire-types.ts'
import css from './SlashInput.module.css'

export interface SlashCommandGroup {
  readonly agentId: string
  readonly agentLabel: string
  readonly commands: readonly AgentSlashCommand[]
}

export interface SlashTriggerMatch {
  readonly startIndex: number
  readonly endIndex: number
  readonly query: string
}

const SLASH_TOKEN_RE = /(?:^|\s)(\/[^\s]*)$/

/** Find an active `/query` token right before `caret` in `value`. */
export function matchSlashToken(value: string, caret: number): SlashTriggerMatch | undefined {
  const before = value.slice(0, Math.max(0, caret))
  const match = SLASH_TOKEN_RE.exec(before)
  if (match === null || match[1] === undefined) return undefined
  // Restrict to start-of-string or start-of-line so prose paths (`foo /bar`) stay clean
  // unless typed cleanly after newline/leading whitespace.
  const token = match[1]
  const startIndex = before.length - token.length
  const preceding = before.slice(0, startIndex)
  if (!/^\s*$/.test(preceding) && !/\n\s*$/.test(preceding)) {
    return undefined
  }
  return {
    startIndex,
    endIndex: caret,
    query: token.slice(1).toLowerCase(),
  }
}

/** Replace `trigger` with `/commandName ` and return the new text + caret offset. */
export function applySlashInsertion(
  value: string,
  trigger: SlashTriggerMatch,
  commandName: string,
): { readonly nextValue: string; readonly nextCaret: number } {
  const cleanName = commandName.replace(/^\/+/, '')
  const inserted = `/${cleanName} `
  const nextValue = value.slice(0, trigger.startIndex) + inserted + value.slice(trigger.endIndex)
  return {
    nextValue,
    nextCaret: trigger.startIndex + inserted.length,
  }
}

interface FlatItem {
  readonly agentId: string
  readonly agentLabel: string
  readonly command: AgentSlashCommand
}

export interface SlashInputProps {
  readonly as?: 'input' | 'textarea' | undefined
  readonly value: string
  readonly onChange: (value: string) => void
  readonly groups: readonly SlashCommandGroup[]
  readonly className?: string | undefined
  readonly placeholder?: string | undefined
  readonly id?: string | undefined
  readonly headerLabel?: string | undefined
}

export function SlashInput({
  as = 'input',
  value,
  onChange,
  groups,
  className,
  placeholder,
  id,
  headerLabel = 'CLI Slash Commands',
}: SlashInputProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState<number>(value.length)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({})

  const trigger = useMemo(() => matchSlashToken(value, caret), [value, caret])

  const filteredGroups = useMemo(() => {
    if (trigger === undefined) return []
    const q = trigger.query
    const out: SlashCommandGroup[] = []
    for (const group of groups) {
      const matching = group.commands.filter((cmd) => {
        if (q === '') return true
        return cmd.name.toLowerCase().includes(q)
          || (cmd.description?.toLowerCase().includes(q) ?? false)
      })
      if (matching.length > 0) {
        out.push({ ...group, commands: matching })
      }
    }
    return out
  }, [groups, trigger])

  const flatItems: readonly FlatItem[] = useMemo(
    () => filteredGroups.flatMap(g => g.commands.map(command => ({ agentId: g.agentId, agentLabel: g.agentLabel, command }))),
    [filteredGroups],
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [trigger?.query, flatItems.length])

  const showPopover = focused && !dismissed && trigger !== undefined && flatItems.length > 0

  useLayoutEffect(() => {
    if (!showPopover || typeof window === 'undefined') return
    const updatePosition = (): void => {
      const anchor = wrapperRef.current
      if (anchor === null) return
      const rect = anchor.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const spaceBelow = viewportHeight - rect.bottom - 8
      const spaceAbove = rect.top - 8
      const openBelow = spaceBelow >= 200 || spaceBelow >= spaceAbove
      const maxHeight = Math.min(240, Math.max(120, openBelow ? spaceBelow : spaceAbove))
      setPopoverStyle({
        left: `${Math.max(8, rect.left)}px`,
        width: `${Math.max(280, rect.width)}px`,
        maxHeight: `${maxHeight}px`,
        ...(openBelow
          ? { top: `${rect.bottom + 6}px` }
          : { bottom: `${viewportHeight - rect.top + 6}px` }),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [showPopover])

  const selectCommand = (command: AgentSlashCommand): void => {
    if (trigger === undefined) return
    const { nextValue, nextCaret } = applySlashInsertion(value, trigger, command.name)
    onChange(nextValue)
    setCaret(nextCaret)
    setDismissed(true)
    requestAnimationFrame(() => {
      const el = as === 'textarea' ? textareaRef.current : inputRef.current
      if (el !== null) {
        el.focus()
        el.setSelectionRange(nextCaret, nextCaret)
      }
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (!showPopover) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(i => (i + 1) % flatItems.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(i => (i - 1 + flatItems.length) % flatItems.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const chosen = flatItems[activeIndex]
      if (chosen !== undefined) {
        event.preventDefault()
        selectCommand(chosen.command)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
    }
  }

  let runningIndex = 0

  const popoverNode = showPopover ? (
    <div className={css.popover} style={popoverStyle} role="listbox" aria-label={headerLabel}>
      <div className={css.header}>
        <IconAgentPresetOutlineRegular className={css.headerIcon} />
        <span>{headerLabel}</span>
      </div>
      {filteredGroups.map(group => (
        <div key={group.agentId}>
          {filteredGroups.length > 1 ? (
            <div className={css.groupLabel}>{group.agentLabel}</div>
          ) : null}
          {group.commands.map((cmd) => {
            const idx = runningIndex++
            const isActive = idx === activeIndex
            return (
              <button
                key={`${group.agentId}:${cmd.name}`}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`${css.item} ${isActive ? css.itemActive : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectCommand(cmd)
                }}
              >
                <span className={css.itemLeft}>
                  <span className={css.cmdName}>/{cmd.name.replace(/^\/+/, '')}</span>
                  {cmd.argumentHint ? <span className={css.argHint}>{cmd.argumentHint}</span> : null}
                </span>
                {cmd.description ? <span className={css.description}>{cmd.description}</span> : null}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  ) : null

  return (
    <div ref={wrapperRef} className={css.wrapper}>
      {as === 'textarea' ? (
        <textarea
          ref={textareaRef}
          id={id}
          className={className}
          value={value}
          placeholder={placeholder}
          onFocus={(e) => {
            setFocused(true)
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
          }}
          onBlur={() => { setFocused(false) }}
          onClick={(e) => { setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length) }}
          onKeyUp={(e) => { setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length) }}
          onKeyDown={handleKeyDown}
          onChange={(e) => {
            setDismissed(false)
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
            onChange(e.currentTarget.value)
          }}
        />
      ) : (
        <input
          ref={inputRef}
          id={id}
          className={className}
          value={value}
          placeholder={placeholder}
          onFocus={(e) => {
            setFocused(true)
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
          }}
          onBlur={() => { setFocused(false) }}
          onClick={(e) => { setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length) }}
          onKeyUp={(e) => { setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length) }}
          onKeyDown={handleKeyDown}
          onChange={(e) => {
            setDismissed(false)
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
            onChange(e.currentTarget.value)
          }}
        />
      )}

      {popoverNode !== null && typeof document !== 'undefined'
        ? createPortal(popoverNode, document.body)
        : popoverNode}
    </div>
  )
}
