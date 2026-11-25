/**
 * The notification hub: producers (the executor's ask; later the Steward)
 * publish through {@link DshManagerNotifications.notify}, which fans out to
 * every registered outlet — the outlet interface is replaceable and the
 * producer never depends on an implementation (spec story 78). The MVP
 * outlet is the GUI feed: an in-memory ring the client polls.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { ManagerNotification, NotificationOutlet, NotificationView } from './notifications/notification-core.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The notification hub the bundle's producers publish through. */
    dshManagerNotifications: DshManagerNotifications
  }
}

/** Notifications facet configuration. */
export interface NotificationsConfig {}

export const NotificationsConfig: z<NotificationsConfig> = z.object({})

/** The GUI feed ring's size; the oldest row falls off. */
const FEED_LIMIT = 100

export class DshManagerNotifications extends TypertRemoteService {
  static inject = []

  static Config: z<NotificationsConfig> = NotificationsConfig

  /** The registered outlets, in registration order. */
  private outlets: NotificationOutlet[] = []

  /** The GUI feed: every notification the GUI outlet received, newest last. */
  private feed: NotificationView[] = []

  constructor(ctx: Context, config: NotificationsConfig) {
    super(ctx, 'dshManagerNotifications', { namespace: 'dshManager' })
    void config
  }

  protected [Service.init](): void {
    // The MVP outlet: the in-GUI feed the client polls (stories 77/78).
    this.registerOutlet({
      id: 'gui',
      notify: async notification => {
        if (notification.kind === 'progress') return
        this.feed = [...this.feed, {
          id: notification.id,
          kind: notification.kind,
          attentionId: notification.attentionId,
          ticketId: notification.ticketId,
          title: notification.title,
          at: notification.at,
        }].slice(-FEED_LIMIT)
      },
    })
  }

  /**
   * Register one outlet; returns its disposer. One outlet failing must not
   * fail its peers, so `notify` isolates each fan-out leg.
   */
  registerOutlet(outlet: NotificationOutlet): () => void {
    this.outlets.push(outlet)
    return () => {
      this.outlets = this.outlets.filter(registered => registered !== outlet)
    }
  }

  /** Publish one notification to every outlet; a failing leg logs, never throws. */
  async notify(notification: ManagerNotification): Promise<void> {
    for (const outlet of this.outlets) {
      try {
        await outlet.notify(notification)
      } catch (error) {
        this.ctx.logger?.warn('notification outlet %s failed: %s', outlet.id, String(error))
      }
    }
  }

  /** The GUI feed, newest first. */
  @Remote
  async notificationList(): Promise<{ readonly notifications: readonly NotificationView[] }> {
    return { notifications: [...this.feed].reverse() }
  }
}

export type { ManagerNotification, NotificationOutlet, NotificationView }
export default DshManagerNotifications
