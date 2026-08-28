import type { ApiAction, ExecutedApiStep } from './apiTypes'
import type { AgentAction, ExecutedStep } from './types'

const MUTATION_MARKER = '__five46_mutation_probe__'

/** Assertions whose expected value can be flipped to something the real
 * response/page is essentially guaranteed not to match.
 * `assert_json_path_exists`/`assert_visible` have no expected value to
 * flip (that's exactly what `assertionQuality.ts` already flags as weak).
 * `assert_page_text_absent` is excluded too: it passes when its text is
 * NOT found, so mutating the text to something nonsensical would still
 * trivially be absent — flipping it can't produce a real negative
 * control the way flipping a value-equality check can. */
const MUTABLE_API_ASSERTIONS = new Set<ApiAction['action']>(['assert_status', 'assert_json_path_equals'])
const MUTABLE_AGENT_ASSERTIONS = new Set<AgentAction['action']>(['assert_text', 'assert_value', 'assert_page_text'])

function mutateApiAction(action: ApiAction): ApiAction {
  if (action.action === 'assert_status') return { ...action, expected: action.expected === 599 ? 200 : 599 }
  if (action.action === 'assert_json_path_equals') return { ...action, expected: `${action.expected}${MUTATION_MARKER}` }
  return action
}

function mutateAgentAction(action: AgentAction): AgentAction {
  if (action.action === 'assert_text') return { ...action, expectedText: `${action.expectedText}${MUTATION_MARKER}` }
  if (action.action === 'assert_value') return { ...action, expectedValue: `${action.expectedValue}${MUTATION_MARKER}` }
  if (action.action === 'assert_page_text') return { ...action, expectedText: `${action.expectedText}${MUTATION_MARKER}` }
  return action
}

/** Clones `steps` with every successful, mutable assertion's expected value
 * flipped — for a negative-control check: re-executing the resulting spec
 * should fail if the original assertions were actually load-bearing.
 * Returns `undefined` when nothing in the run was mutable, so the caller
 * can report "nothing to verify" rather than running a no-op check. */
export function buildMutatedApiSteps(steps: ExecutedApiStep[]): ExecutedApiStep[] | undefined {
  let mutatedAny = false
  const mutated = steps.map((step) => {
    if (!step.ok || !MUTABLE_API_ASSERTIONS.has(step.action.action)) return step
    mutatedAny = true
    return { ...step, action: mutateApiAction(step.action) }
  })
  return mutatedAny ? mutated : undefined
}

export function buildMutatedAgentSteps(steps: ExecutedStep[]): ExecutedStep[] | undefined {
  let mutatedAny = false
  const mutated = steps.map((step) => {
    if (!step.ok || !MUTABLE_AGENT_ASSERTIONS.has(step.action.action)) return step
    mutatedAny = true
    return { ...step, action: mutateAgentAction(step.action) }
  })
  return mutatedAny ? mutated : undefined
}
