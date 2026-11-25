import type { ReactNode } from 'react'

/** Minimal Node/SSR test facade for `@deepseek-ai/dsh-client-ui-primitives` avoiding heavy devDeps (`shiki`/`katex`/`simple-icons`) and CSS modules. */
export function Menu({ anchor }: { readonly anchor: ReactNode }): ReactNode {
  return anchor
}

export function IconChevronDownOutlineRegular({ size = 12 }: { readonly size?: number; readonly className?: string }): ReactNode {
  return <svg width={size} height={size} data-icon="dsw-icon-chevron-down-outline-regular" aria-hidden="true" />
}
