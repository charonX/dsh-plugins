/**
 * The notification domain core: what a producer (the executor's ask, later
 * the Steward) hands to a replaceable outlet (spec story 78). The outlet
 * decides how the notification surfaces; the MVP outlet surfaces it inside
 * the GUI.
 */

import type { AttentionKind } from '../attention/attention-core.ts'

/** What a notification carries across outlets. */
export type NotificationKind = 'attention' | 'progress'

/** Who initiated the event behind a notification, for echo suppression. */
export type NotificationOrigin = 'web' | 'im-tool' | 'system'

/** One notification a producer publishes to an outlet. */
export interface ManagerNotification {
  readonly id: string
  /** What kind of event the notification carries. */
  readonly kind: NotificationKind
  /** The attention the notification points at; empty for non-attention kinds. */
  readonly attentionId: string
  readonly ticketId: string
  /** The one-line copy the outlet may surface verbatim. */
  readonly title: string
  readonly at: number
  /** Optional kind of attention, when `kind === 'attention'`. */
  readonly attentionKind?: AttentionKind
  /** Optional supplementary body for richer outlets such as IM. */
  readonly details?: string
  /** Optional origin so an IM outlet skips echoing actions just performed inside IM. */
  readonly origin?: NotificationOrigin
}

/** One replaceable notification outlet; producers never depend on an implementation. */
export interface NotificationOutlet {
  /** Stable outlet identity for diagnostics. */
  readonly id: string
  notify(notification: ManagerNotification): Promise<void>
}

/** One notification as the wire sees it: the polled GUI feed's row. */
export interface NotificationView {
  readonly id: string
  readonly kind: 'attention'
  readonly attentionId: string
  readonly ticketId: string
  readonly title: string
  readonly at: number
}
