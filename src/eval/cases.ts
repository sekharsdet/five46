import { startFixtureServer, startScrollFixtureServer, startWidgetsFixtureServer } from '../agent/testServer'
import { startLoginFixtureServer, LOGIN_FIXTURE_USERNAME, LOGIN_FIXTURE_PASSWORD } from '../agent/loginTestServer'
import type { LoginCredentials } from '../agent/browser'
import type { RunOutcome } from '../agent/types'

/** One `{ url, close }` pair a case's `target` resolves to — either a
 * fixed, already-running public URL (`kind: 'url'`), or a fresh local
 * fixture server started/stopped once per case (`kind: 'fixture'`) so a
 * fast, deterministic, network-free case never depends on a third-party
 * site staying up. */
export type EvalTarget =
  | { kind: 'url'; url: string }
  | { kind: 'fixture'; start: () => Promise<{ url: string; close: () => Promise<void> }> }

/** One curated regression case — see `src/eval/run.ts`'s own doc comment
 * for why this file exists at all: the standing answer to "we keep
 * discovering the same category of gap on every new site," not another
 * one-off live-testing session. Every case here is either (a) a permanent,
 * automatically-re-verified record of a real gap already found and fixed
 * across this project's live-testing sessions, or (b) a deliberate,
 * evidence-gathering probe for a commonly-needed interaction pattern this
 * project has never actually validated end-to-end. */
export interface EvalCase {
  name: string
  goal: string
  target: EvalTarget
  maxSteps?: number
  /** Default `'goal-reached'` — the overwhelming majority of cases assert
   * the goal actually completes. A small number of cases exist specifically
   * to prove a *different* outcome is the honest, correct one (e.g. a
   * goal-unreachable case) — those set this explicitly. */
  expectedOutcome?: RunOutcome
  credentials?: LoginCredentials
}

const WIDGETS = { kind: 'fixture', start: startWidgetsFixtureServer } as const

export const EVAL_CASES: EvalCase[] = [
  // --- Regression cases: real gaps already found and fixed, kept as
  // permanent, automatic re-verification instead of one-off manual checks. ---
  {
    name: 'reveal-secret (baseline click/fill/assert)',
    goal: "click the button to reveal the secret message, then confirm it says 'agentic testing works'",
    target: { kind: 'fixture', start: startFixtureServer },
  },
  {
    name: 'contenteditable region is fillable',
    goal: "fill the Notes editor with 'Remember to buy milk', click Save notes, and confirm it says the notes were saved with that exact text",
    target: WIDGETS,
  },
  {
    name: 'dismiss-notice (assert_page_text_absent)',
    goal: "click 'Dismiss notice' and confirm the page no longer shows 'You have unread notifications'",
    target: { kind: 'fixture', start: startFixtureServer },
  },
  {
    name: 'scroll to an off-screen element',
    goal: "scroll down, click the Bottom button, and confirm its status text says 'Bottom clicked'",
    target: { kind: 'fixture', start: startScrollFixtureServer },
  },
  {
    name: 'login flow with credential placeholders',
    goal: 'log in and confirm the dashboard shows a welcome message',
    target: { kind: 'fixture', start: startLoginFixtureServer },
    credentials: { username: LOGIN_FIXTURE_USERNAME, password: LOGIN_FIXTURE_PASSWORD },
  },
  {
    name: 'the-internet.herokuapp.com hover (img alt, no role/title/cursor)',
    goal: "hover over the first user figure and confirm its caption with a 'View profile' link appears",
    target: { kind: 'url', url: 'https://the-internet.herokuapp.com/hovers' },
  },
  {
    name: 'the-internet.herokuapp.com iframe/nested_frames',
    goal: "confirm the middle frame shows the text 'MIDDLE'",
    target: { kind: 'url', url: 'https://the-internet.herokuapp.com/nested_frames' },
  },
  {
    name: 'the-internet.herokuapp.com JS alert dialog',
    goal: 'click the button that triggers a plain JS alert, accept it, then confirm the result text shows the alert was successfully clicked',
    target: { kind: 'url', url: 'https://the-internet.herokuapp.com/javascript_alerts' },
  },
  {
    name: 'the-internet.herokuapp.com new window/tab',
    goal: "click the link that opens a new window, then confirm the new window/tab shows the text 'New Window'",
    target: { kind: 'url', url: 'https://the-internet.herokuapp.com/windows' },
  },
  {
    name: 'TodoMVC add/complete/filter (negative assertion)',
    goal: "add a todo called 'buy milk', mark it complete, click the Active filter, and confirm the page no longer shows 'buy milk'",
    target: { kind: 'url', url: 'https://todomvc.com/examples/react/dist/' },
    maxSteps: 14,
  },

  // --- Originally added as deliberate, evidence-gathering probes for
  // patterns never validated end-to-end before (native <select>, drag-and-
  // drop, double-click, ambiguous duplicate-named refs) — kept here now as
  // permanent regression cases once the probe run itself proved real gaps
  // (dblclick, drag, assert_value all added directly because of these) and
  // confirmed the rest already worked. ---
  {
    name: 'native <select> dropdown',
    goal: "select 'Green' from the favorite color dropdown and confirm it shows as selected",
    target: WIDGETS,
  },
  {
    name: 'mouse-based drag-and-drop reorder',
    goal: "drag 'Item C' to the top of the list, above 'Item A', and confirm the new order starts with Item C",
    target: WIDGETS,
  },
  {
    name: 'double-click to enter edit mode, then assert the field VALUE',
    goal: "double-click the 'Double-click to edit' label, then confirm the editable text field's value is 'Edited!'",
    target: WIDGETS,
  },
  {
    name: 'duplicate-named buttons (ambiguous ref resolution)',
    goal: "click the Delete button for Task 2 specifically, and confirm the page shows 'Deleted task 2' (not task 1 or 3)",
    target: WIDGETS,
  },
]
