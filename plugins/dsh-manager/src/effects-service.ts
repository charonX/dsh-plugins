/**
 * Host service behind the outbound effect queue (ADR-0003): one durable
 * queue over the effects domain, a per-kind deliverer registry, and a
 * boot-time recovery sweep. Feature code registers deliverers and enqueues;
 * targets dedup on the effect id.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { EffectDelivery, EffectDeliverer, EffectQueue, EffectRecord } from './effects/effect-queue.ts'
import { createEffectQueue, MissingDelivererError } from './effects/effect-queue.ts'
import { effectsDomain } from './effects/effects-domain.ts'
import { createDomainEffectStore } from './effects/storage-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable outbound effect queue with per-kind deliverer registry. */
    dshManagerEffects: DshManagerEffects
  }
}

/** Effect queue facet configuration. */
export interface EffectsConfig {}

export const EffectsConfig: z<EffectsConfig> = z.object({})

/** Mounts the effect queue over storage-domain and recovers on boot. */
export class DshManagerEffects extends Service {
  /** Host services the queue reads. */
  static inject = ['storageDomain']

  static Config: z<EffectsConfig> = EffectsConfig

  private queue?: EffectQueue
  private readonly deliverers = new Map<string, EffectDeliverer>()

  constructor(ctx: Context, config: EffectsConfig) {
    super(ctx, 'dshManagerEffects')
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(effectsDomain)
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close effects domain')
    const queue = createEffectQueue({
      store: createDomainEffectStore(this.ctx, domain),
      deliver: async (delivery) => {
        const handler = this.deliverers.get(delivery.kind)
        if (handler === undefined) throw new MissingDelivererError(delivery.kind)
        await handler(delivery)
      },
    })
    this.ctx.effect(() => async () => { await queue.stop() }, 'dsh-manager: stop effect queue')
    this.queue = queue
    // Converge whatever the last process left behind: in-flight re-delivers
    // (targets dedup), due pending records resume, failed stays queryable.
    await queue.recover()
  }

  /**
   * Register the deliverer for one effect kind.
   * @param kind - dispatch discriminator the effect was enqueued under.
   * @param deliverer - performs the outward action; rejection retries with backoff.
   * @returns a disposer removing the registration.
   */
  register(kind: string, deliverer: EffectDeliverer): () => void {
    this.deliverers.set(kind, deliverer)
    return () => {
      if (this.deliverers.get(kind) === deliverer) this.deliverers.delete(kind)
    }
  }

  /**
   * Enqueue one outbound effect; it survives restarts until it settles.
   * @param kind - dispatch discriminator.
   * @param payload - JSON payload handed to the kind's deliverer.
   * @returns the effect's idempotency key.
   */
  async enqueue(kind: string, payload: unknown): Promise<string> {
    const queue = this.queue
    if (queue === undefined) throw new Error('dsh-manager: effect queue is not running')
    return await queue.enqueue({ kind, payload })
  }

  /** Every stored effect record, for queryable diagnosis (failed states included). */
  listEffects(): readonly EffectRecord[] {
    return this.queue === undefined ? [] : this.queue.records()
  }
}

export type { EffectDelivery }
export default DshManagerEffects
