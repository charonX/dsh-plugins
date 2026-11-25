// @vitest-environment jsdom
/** Unit & UI interaction tests for Dsh Manager's SlashInput autocomplete control. */
import { createElement, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import {
  applySlashInsertion,
  matchSlashToken,
  SlashInput,
  type SlashCommandGroup,
} from '../../src/client/SlashInput.tsx'

afterEach(() => {
  cleanup()
})

const GROUPS: readonly SlashCommandGroup[] = [
  {
    agentId: 'claude-code',
    agentLabel: 'claude-code',
    commands: [
      { name: 'review', description: 'Review current diff', argumentHint: '[pr]' },
      { name: 'gsd:plan', description: 'Create implementation plan' },
    ],
  },
]

function ControlledHarness({ as }: { readonly as: 'input' | 'textarea' }) {
  const [value, setValue] = useState('')
  return createElement(SlashInput, {
    as,
    value,
    onChange: setValue,
    groups: GROUPS,
    placeholder: 'instruction',
  })
}

describe('SlashInput', () => {
  test('matchSlashToken matches start-of-string and start-of-line tokens only', () => {
    expect(matchSlashToken('/rev', 4)).toEqual({ startIndex: 0, endIndex: 4, query: 'rev' })
    expect(matchSlashToken('  /gsd', 6)).toEqual({ startIndex: 2, endIndex: 6, query: 'gsd' })
    expect(matchSlashToken('context\n/pl', 11)).toEqual({ startIndex: 8, endIndex: 11, query: 'pl' })
    expect(matchSlashToken('fix /Users/dev', 14)).toBeUndefined()
  })

  test('applySlashInsertion replaces matched token with /name and trailing space', () => {
    const trigger = { startIndex: 2, endIndex: 6, query: 'rev' }
    expect(applySlashInsertion('  /rev', trigger, '/review')).toEqual({
      nextValue: '  /review ',
      nextCaret: 10,
    })
  })

  test('renders filtered listbox on / in textarea and inserts selected command on Enter', () => {
    render(createElement(ControlledHarness, { as: 'textarea' }))
    const field = screen.getByPlaceholderText('instruction') as HTMLTextAreaElement
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '/rev', selectionStart: 4 } })

    const option = screen.getByRole('option')
    expect(option.textContent).toContain('/review')
    expect(option.textContent).toContain('[pr]')
    expect(option.textContent).toContain('Review current diff')

    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('/review ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
