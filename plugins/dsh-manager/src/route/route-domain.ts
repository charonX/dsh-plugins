/**
 * The route domain: allocation rules over storage-domain — the persistence
 * adapter behind the route core (ADR-0003).
 */
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { routeRule, type RouteRule } from './route-core.ts'

/** Stable route-rule identity. */
export type RouteRuleId = Branded<'RouteRuleId'>

/** Durable route state: one mutable record per rule. */
export const routeDomain = defineDomain({
  name: 'dsh_manager_route',
  version: 1,
  tables: {
    rules: domainTable<RouteRuleId, RouteRule>(routeRule),
  },
})
