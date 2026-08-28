import type { ApiAction, ExecutedApiStep } from './apiTypes'
import type { AgentAction, ExecutedStep } from './types'

export type AssertionStrength = 'weak' | 'strong'

const WEAK_API_ASSERTIONS = new Set<ApiAction['action']>(['assert_json_path_exists'])
const WEAK_AGENT_ASSERTIONS = new Set<AgentAction['action']>(['assert_visible'])

const API_ASSERTION_ACTIONS = new Set<ApiAction['action']>(['assert_status', 'assert_json_path_exists', 'assert_json_path_equals'])
const AGENT_ASSERTION_ACTIONS = new Set<AgentAction['action']>([
  'assert_visible',
  'assert_text',
  'assert_value',
  'assert_page_text',
  'assert_page_text_absent',
])

export function classifyApiAssertion(action: ApiAction): AssertionStrength {
  return WEAK_API_ASSERTIONS.has(action.action) ? 'weak' : 'strong'
}

export function classifyAgentAssertion(action: AgentAction): AssertionStrength {
  return WEAK_AGENT_ASSERTIONS.has(action.action) ? 'weak' : 'strong'
}

export interface AssertionQualitySummary {
  weak: number
  strong: number
}

export function summarizeApiAssertionQuality(steps: ExecutedApiStep[]): AssertionQualitySummary {
  const summary: AssertionQualitySummary = { weak: 0, strong: 0 }
  for (const step of steps) {
    if (!step.ok || !API_ASSERTION_ACTIONS.has(step.action.action)) continue
    if (classifyApiAssertion(step.action) === 'weak') summary.weak++
    else summary.strong++
  }
  return summary
}

export function summarizeAgentAssertionQuality(steps: ExecutedStep[]): AssertionQualitySummary {
  const summary: AssertionQualitySummary = { weak: 0, strong: 0 }
  for (const step of steps) {
    if (!step.ok || !AGENT_ASSERTION_ACTIONS.has(step.action.action)) continue
    if (classifyAgentAssertion(step.action) === 'weak') summary.weak++
    else summary.strong++
  }
  return summary
}

/** Warns when a spec's passing assertions are mostly or entirely
 * presence-only checks (`assert_visible`/`assert_json_path_exists`) rather
 * than checks against a specific expected value — the two are both counted
 * toward `requiredAssertionCount`, but only the latter actually proves the
 * goal, not just that something loaded. */
export function formatAssertionQualityWarning(summary: AssertionQualitySummary, kind: 'api' | 'browser'): string | undefined {
  if (summary.weak === 0 || summary.weak < summary.strong) return undefined
  const presenceOnly = kind === 'api' ? 'assert_json_path_exists' : 'assert_visible'
  const valueSpecific = kind === 'api' ? 'assert_status/assert_json_path_equals' : 'assert_text/assert_value/assert_page_text'
  return `\nWarning: ${summary.weak}/${summary.weak + summary.strong} assertion(s) in this spec are presence-only (${presenceOnly}), which confirm something loaded but not that it has the right value. Consider whether a ${valueSpecific} check would prove the goal more directly.`
}
