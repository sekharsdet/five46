#!/usr/bin/env node
import { writeFileSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { getLlmProvider, supportedLlmProviderIds } from './llm/registry'
import { loadConfigFile, saveConfigFile, configFilePath } from './config/store'
import { resolveCredentials } from './config/resolve'
import { createPromptSession } from './config/prompt'
import { writeSecureFile } from './config/secureWrite'
import type { Five46Config } from './config/types'
import { runAgent } from './agent/runner'
import { generateAgentSpec } from './agent/generateSpec'
import { formatFailureReport } from './agent/failureReport'
import { AgentBrowserUnavailableError } from './agent/browser'
import type { StorageState, LoginCredentials } from './agent/browser'
import { resolveLoginCredentials, resolveApiAuthHeaders } from './agent/credentials'
import { redactSecrets } from './agent/redact'
import { runApiTest } from './agent/apiRunner'
import { generateApiSpec } from './agent/generateApiSpec'
import { formatApiFailureReport } from './agent/apiFailureReport'
import type { SafetyMode } from './agent/apiTypes'
import { generateRootCauseHypothesis } from './agent/rootCause'
import { generateApiRootCauseHypothesis } from './agent/apiRootCause'
import { diffSpecFiles, formatDiff } from './agent/diffSpecs'
import { classifyRepeatResults } from './agent/flaky'
import type { RepeatIterationResult } from './agent/flaky'
import { HARD_MAX_REPEAT } from './agent/runLoop'
import type { RunOutcome } from './agent/types'
import type { LlmProvider } from './llm/types'
import { loadProjectConfig, resolveProject, mergeProjectDefaultsForTest, mergeProjectDefaultsForApi } from './config/projectConfig'

export interface ParsedAgentArgs {
  url?: string
  goal?: string
  maxSteps?: number
  headed?: boolean
  out?: string
  storageState?: string
  allowDeletes?: boolean
  noRootCause?: boolean
  /** `test`/`api` only — see `runRepeatedE2eTest`/`runRepeatedApiTestCommand`.
   * Harmlessly parsed but never read by `login` (see `--allow-deletes`'s
   * own comment above for why the shared parser doesn't bother excluding it). */
  repeat?: number
  /** Names a `five46.config.json` project to pull default flags from — see
   * `config/projectConfig.ts`. Not extended to `login` (its defaults don't
   * map onto `ProjectDefaults`' shape as cleanly); harmlessly parsed but
   * unused there, same as `repeat`. */
  project?: string
  /** `test`/`login` only — see `browser.ts`'s `AgentBrowser.close()`. Not
   * extended to `api` (no browser, structurally impossible to record a
   * video of — the same "no analog, and that's correct" precedent as
   * self-healing selectors), so it's parsed only by this shared parser,
   * never by `parseApiArgs`. */
  recordVideo?: boolean
  /** `test`/`api` only — see `RunAgentOptions.useStructuredPlan`/
   * `RunApiTestOptions.useStructuredPlan`. Not extended to `login` for the
   * same reason `--repeat` isn't: login's deliverable is one durable
   * session file, and its goal vocabulary is always "log in" — there's no
   * multi-step ambiguity for an upfront plan to help resolve. Default-on as
   * of the speed-focused pass that added `noStructuredPlan` below — this
   * bare flag is now redundant (kept parseable so an existing script that
   * already passes it keeps working identically) since there's nothing left
   * for it to turn on that isn't already on by default. */
  structuredPlan?: boolean
  /** The sole opt-out for structured planning's new default-on behavior —
   * see `resolveStructuredPlan()`. Mirrors `noRootCause`'s polarity for a
   * default-on feature with an escape hatch. */
  noStructuredPlan?: boolean
  /** `test`/`api` only — see `RunAgentOptions.useFastSteps`/
   * `RunApiTestOptions.useFastSteps`. Deliberately opt-in (unlike
   * `structuredPlan`'s now-default-on status) — a smaller model is a real,
   * currently-unquantified risk to per-step decision quality, not
   * something to default on without its own live-validation runway first.
   * Not extended to `login` for the same reason `--structured-plan` isn't. */
  fastSteps?: boolean
}

export function parseAgentArgs(argv: string[]): ParsedAgentArgs {
  const result: ParsedAgentArgs = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--goal') {
      result.goal = argv[++i]
    } else if (argv[i] === '--max-steps') {
      const n = Number(argv[++i])
      if (Number.isFinite(n)) result.maxSteps = n
    } else if (argv[i] === '--headed') {
      result.headed = true
    } else if (argv[i] === '--out') {
      result.out = argv[++i]
    } else if (argv[i] === '--storage-state') {
      result.storageState = argv[++i]
    } else if (argv[i] === '--allow-deletes') {
      // Shared with `login`'s dispatch too — parsing it is harmless there,
      // since `runLoginFlow` never reads it (see cli.ts's `login` branch):
      // login's goal vocabulary is always "log in," never "delete," so
      // there's no legitimate use, and this isn't worth a second parser to
      // close off.
      result.allowDeletes = true
    } else if (argv[i] === '--no-root-cause') {
      // Same "shared parser, harmlessly unused by login" reasoning as
      // --allow-deletes above — a failed assertion isn't a `login` outcome
      // at all, so there's nothing for this to opt out of there either.
      result.noRootCause = true
    } else if (argv[i] === '--repeat') {
      const n = Number(argv[++i])
      if (Number.isFinite(n)) result.repeat = n
    } else if (argv[i] === '--project') {
      result.project = argv[++i]
    } else if (argv[i] === '--record-video') {
      result.recordVideo = true
    } else if (argv[i] === '--structured-plan') {
      result.structuredPlan = true
    } else if (argv[i] === '--no-structured-plan') {
      result.noStructuredPlan = true
    } else if (argv[i] === '--fast-steps') {
      result.fastSteps = true
    } else if (!result.url) {
      result.url = argv[i]
    }
  }
  return result
}

/** Resolves `--no-structured-plan` into a definite boolean immediately after
 * parsing, so every downstream consumer (the "one extra LLM call will
 * plan..." disclosure banners, `RunAgentOptions.useStructuredPlan`/
 * `RunApiTestOptions.useStructuredPlan`) sees an already-resolved
 * true/false, never undefined. Structured planning is default-ON as of this
 * change; `--no-structured-plan` is the sole opt-out (mirrors
 * `--no-root-cause`'s polarity for a default-on feature). The bare
 * `--structured-plan` flag no longer has any effect of its own — an
 * explicit opt-out always wins if both are somehow passed. */
export function resolveStructuredPlan(parsed: { noStructuredPlan?: boolean }): boolean {
  return !parsed.noStructuredPlan
}

export interface ParsedApiArgs {
  baseUrl?: string
  goal?: string
  maxSteps?: number
  out?: string
  storageState?: string
  allowWrites: boolean
  allowDeletes: boolean
  allowHosts: string[]
  noRootCause?: boolean
  repeat?: number
  project?: string
  structuredPlan?: boolean
  noStructuredPlan?: boolean
  fastSteps?: boolean
}

export function parseApiArgs(argv: string[]): ParsedApiArgs {
  const result: ParsedApiArgs = { allowWrites: false, allowDeletes: false, allowHosts: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--goal') {
      result.goal = argv[++i]
    } else if (argv[i] === '--max-steps') {
      const n = Number(argv[++i])
      if (Number.isFinite(n)) result.maxSteps = n
    } else if (argv[i] === '--out') {
      result.out = argv[++i]
    } else if (argv[i] === '--storage-state') {
      result.storageState = argv[++i]
    } else if (argv[i] === '--allow-writes') {
      result.allowWrites = true
    } else if (argv[i] === '--allow-deletes') {
      result.allowDeletes = true
    } else if (argv[i] === '--allow-host') {
      result.allowHosts.push(argv[++i])
    } else if (argv[i] === '--no-root-cause') {
      result.noRootCause = true
    } else if (argv[i] === '--repeat') {
      const n = Number(argv[++i])
      if (Number.isFinite(n)) result.repeat = n
    } else if (argv[i] === '--project') {
      result.project = argv[++i]
    } else if (argv[i] === '--structured-plan') {
      result.structuredPlan = true
    } else if (argv[i] === '--no-structured-plan') {
      result.noStructuredPlan = true
    } else if (argv[i] === '--fast-steps') {
      result.fastSteps = true
    } else if (!result.baseUrl) {
      result.baseUrl = argv[i]
    }
  }
  return result
}

/** Loads and minimally validates a `five46 login`-produced session file
 * *before* launching the browser — same fail-fast-before-any-LLM-cost
 * ordering `AgentBrowserUnavailableError` already establishes for a missing
 * Playwright install. Returns `undefined` (having already printed why) on
 * any problem, never throws. */
function loadStorageStateFile(path: string): StorageState | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`\nCouldn't read the storage state file at ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`\n"${path}" isn't valid JSON — expected a session file written by "five46 login".`)
    return undefined
  }
  const candidate = parsed as { cookies?: unknown; origins?: unknown }
  if (!Array.isArray(candidate.cookies) || !Array.isArray(candidate.origins)) {
    console.error(`\n"${path}" doesn't look like a storage-state file (missing "cookies"/"origins" arrays) — expected output from "five46 login".`)
    return undefined
  }
  return parsed as StorageState
}

/** Shared by `test` and `login` — both need the same http(s)/file URL
 * validation before doing anything else. Prints its own error and returns
 * `undefined` on failure, never throws. */
function validateTargetUrl(url: string): URL | undefined {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    console.error(`"${url}" isn't a valid URL — needs a live http(s) or file:// URL.`)
    return undefined
  }
  if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
    console.error(`Needs an http(s) or file:// URL, got "${parsedUrl.protocol}"`)
    return undefined
  }
  return parsedUrl
}

/** `five46 api`'s own URL validation — `file:` makes no sense as an API
 * base URL the way it does for a browser page, so it's rejected here rather
 * than reusing `validateTargetUrl`. */
function validateApiBaseUrl(url: string): URL | undefined {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    console.error(`"${url}" isn't a valid URL — needs a live http(s) URL.`)
    return undefined
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    console.error(`Needs an http(s) URL, got "${parsedUrl.protocol}"`)
    return undefined
  }
  return parsedUrl
}

/** Splices a `.repeatN` marker in before a path's extension, for
 * `--repeat`'s per-iteration `--out` collision avoidance ("foo.spec.ts" + 2
 * -> "foo.spec.repeat2.ts"; no extension -> "foo.repeat2"). Only needed
 * when `--out` is explicitly given — the *default* generated filename
 * already keys off the run's own `runId` (`runLoop.ts`'s `makeRunId()`,
 * unique per call via a random suffix), so repeats never collide without
 * any help when `--out` is omitted. */
export function insertIterationSuffix(path: string, iteration: number): string {
  const lastDot = path.lastIndexOf('.')
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastDot > lastSlash) {
    return `${path.slice(0, lastDot)}.repeat${iteration}${path.slice(lastDot)}`
  }
  return `${path}.repeat${iteration}`
}

/** The actual single-run work shared by `runE2eTest` (one run) and
 * `runRepeatedE2eTest` (`--repeat N` runs): launches the agent, prints the
 * report, writes the generated spec, and returns just enough (outcome +
 * the exact spec body that got written) for a caller to decide CI success
 * or classify a `--repeat` batch as flaky via `classifyRepeatResults`.
 * Preflight (API key, storage state, credentials, banners) happens once in
 * each caller, not here — repeating it per iteration would be pointless
 * (an API key/session doesn't change across repeats) and would spam
 * duplicate banners. */
export async function performOneE2eRun(
  url: string,
  goal: string,
  maxSteps: number | undefined,
  headed: boolean | undefined,
  outArg: string | undefined,
  artifactDir: string,
  storageState: StorageState | undefined,
  allowDeletes: boolean | undefined,
  noRootCause: boolean | undefined,
  recordVideo: boolean | undefined,
  structuredPlan: boolean | undefined,
  provider: LlmProvider,
  llmApiKey: string,
  credentials: LoginCredentials,
  secrets: (string | undefined)[],
  projectName: string | undefined,
  fastSteps: boolean | undefined
): Promise<{ outcome: RunOutcome; specBody: string } | 'errored'> {
  let run
  try {
    run = await runAgent({
      url,
      goal,
      provider,
      apiKey: llmApiKey,
      maxSteps,
      headless: !headed,
      artifactDir,
      storageState,
      credentials,
      allowDeletes,
      recordVideo,
      useStructuredPlan: structuredPlan,
      useFastSteps: fastSteps,
      onDestructiveClick: (name, reason) => console.log(`  -> clicking "${redactSecrets(name, secrets)}" (${redactSecrets(reason, secrets)})`),
    })
  } catch (err) {
    if (err instanceof AgentBrowserUnavailableError) {
      console.error(`\n${err.message}`)
      return 'errored'
    }
    // Any other error (a provider exception, a network failure) must still
    // go through redactSecrets — an uncaught rethrow here would bypass the
    // whole report-formatting path this function otherwise routes every
    // output surface through, for exactly the run that's most likely to
    // have just made a real, secret-bearing LLM call.
    console.error(`\nfive46 test failed: ${redactSecrets(err instanceof Error ? err.message : String(err), secrets)}`)
    return 'errored'
  }

  let rootCauseHypothesis: string | undefined
  if (run.outcome === 'assertion-failed' && !noRootCause) {
    console.log('\nGenerating a root-cause hypothesis for this failure (one additional LLM call)...')
    rootCauseHypothesis = redactSecrets(await generateRootCauseHypothesis(run, provider, llmApiKey), secrets)
  }

  console.log(`\n${redactSecrets(formatFailureReport(run, rootCauseHypothesis), secrets)}`)

  const outPath = outArg ?? join(process.cwd(), `five46-agent-${run.runId}.spec.ts`)
  let specBody = redactSecrets(generateAgentSpec(run), secrets)
  if (projectName) specBody = withProjectHeaderLine(specBody, projectName)
  writeFileSync(outPath, specBody, 'utf8')
  console.log(`\nWrote ${run.steps.filter((s) => s.ok).length} confirmed-working step(s) to ${outPath}`)
  return { outcome: run.outcome, specBody }
}

/**
 * `five46 test <url>` — an agentic, BYOK, fully local E2E testing mode:
 * an LLM (the user's own key) drives a real local Playwright browser toward
 * a stated goal, one action at a time, and a real, standalone, re-runnable
 * Playwright spec comes out the other side. See DEVELOPMENT.md for the full
 * design rationale (why local execution, why single-shot-JSON-per-step,
 * what's deliberately deferred).
 */
/** Returns whether the run should be treated as a CI success — exactly
 * `outcome === 'goal-reached'`, never anything else. `goal-unreachable`,
 * `assertion-failed`, `stuck-repeating`, `stopped-by-cap`, and
 * `unparseable-response` are all genuinely "the goal was not verifiably
 * achieved," even though only `assertion-failed` is a finding about the
 * app under test rather than a tooling issue — a CI pipeline invoking
 * `five46 test` needs one clear yes/no signal via the exit code, not a
 * finer-grained taxonomy (that's what the printed report is for). Also
 * returned as `false` for every early-return path (missing key, an
 * unreadable/invalid storage-state file, `AgentBrowserUnavailableError`,
 * any other thrown error) — those are just as much "this command did not
 * do what was asked" as a real run ending badly. */
async function runE2eTest(
  url: string,
  goal: string,
  maxSteps: number | undefined,
  headed: boolean | undefined,
  outArg: string | undefined,
  storageStatePath: string | undefined,
  allowDeletes: boolean | undefined,
  noRootCause: boolean | undefined,
  recordVideo: boolean | undefined,
  structuredPlan: boolean | undefined,
  projectName: string | undefined,
  fastSteps: boolean | undefined
): Promise<boolean> {
  const { llmProvider, llmApiKey } = resolveCredentials()
  if (!llmApiKey) {
    console.error('\nfive46 test requires an LLM API key.')
    console.error(
      'Run `five46 config` to save one, or set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY as environment variables.'
    )
    return false
  }
  const provider = getLlmProvider(llmProvider || 'openai', (info) =>
    console.log(`  (transient error, retrying attempt ${info.attempt + 1}/${info.maxAttempts} in ${info.delayMs}ms: ${info.error instanceof Error ? info.error.message : String(info.error)})`)
  )

  let storageState: StorageState | undefined
  if (storageStatePath) {
    storageState = loadStorageStateFile(storageStatePath)
    if (!storageState) return false
  }

  const credentials = resolveLoginCredentials()
  // The LLM key belongs in this list too — it's the one secret present in
  // literally every run. Latent today (no provider currently embeds it in
  // an error message), but the whole point of this belt-and-suspenders
  // layer is covering a future change this design didn't anticipate.
  const secrets = [credentials.username, credentials.password, llmApiKey]

  console.log(`\nfive46 test: driving a real local browser toward: "${goal}"`)
  console.log(`This page's visible text/labels/values are sent to ${provider.id} (your own API key) on every step.`)
  if (storageState) console.log(`Starting already authenticated, using the session at ${storageStatePath}.`)
  if (credentials.username || credentials.password) {
    console.log('A login username/password is configured — never sent to the LLM, only used locally if the agent fills a credential field.')
  }
  console.log(
    'Note: this run is not deterministic — the same goal/page can take a different path next time. ' +
      'The generated spec below is the frozen, re-runnable artifact; this command itself is an authoring tool, not a repeatable check.'
  )

  const runId = Date.now().toString(36)
  const artifactDir = join(process.cwd(), `five46-agent-${runId}`)
  if (recordVideo) console.log(`A full .webm video of this session will be recorded to ${artifactDir} once the run finishes.`)
  if (structuredPlan) console.log('One extra LLM call will plan the whole goal upfront; most steps then execute without a further live decision.')

  const result = await performOneE2eRun(
    url,
    goal,
    maxSteps,
    headed,
    outArg,
    artifactDir,
    storageState,
    allowDeletes,
    noRootCause,
    recordVideo,
    structuredPlan,
    provider,
    llmApiKey,
    credentials,
    secrets,
    projectName,
    fastSteps
  )
  return result !== 'errored' && result.outcome === 'goal-reached'
}

/** `five46 test <url> --goal "..." --repeat N` — runs the identical goal
 * against the identical target N times *sequentially* (never
 * `Promise.all` — matches the step-cap's own BYOK-cost-consciousness:
 * parallel iterations don't reduce total LLM spend, only wall-clock time,
 * while adding the risk of hitting a provider rate limit across every
 * iteration at once) and reports whether the goal is flaky: either the
 * outcome differs across repeats, or the outcome is the same everywhere
 * but the agent's actual behavior (the generated spec body) differs —
 * see `classifyRepeatResults` (agent/flaky.ts), which reuses the exact
 * same diff primitive `five46 diff` itself uses. Preflight (API key,
 * storage state, credentials) happens once, not per iteration. Returns
 * `true` (CI success) only when every repeat reached `goal-reached` with
 * byte-identical generated output — the strictest, most useful signal for
 * "is this goal actually deterministic," matching the project's existing
 * CI-gating convention of one clear yes/no rather than a finer taxonomy. */
async function runRepeatedE2eTest(
  url: string,
  goal: string,
  maxSteps: number | undefined,
  headed: boolean | undefined,
  outArg: string | undefined,
  storageStatePath: string | undefined,
  allowDeletes: boolean | undefined,
  noRootCause: boolean | undefined,
  recordVideo: boolean | undefined,
  structuredPlan: boolean | undefined,
  repeat: number,
  projectName: string | undefined,
  fastSteps: boolean | undefined
): Promise<boolean> {
  const { llmProvider, llmApiKey } = resolveCredentials()
  if (!llmApiKey) {
    console.error('\nfive46 test requires an LLM API key.')
    console.error(
      'Run `five46 config` to save one, or set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY as environment variables.'
    )
    return false
  }
  const provider = getLlmProvider(llmProvider || 'openai', (info) =>
    console.log(`  (transient error, retrying attempt ${info.attempt + 1}/${info.maxAttempts} in ${info.delayMs}ms: ${info.error instanceof Error ? info.error.message : String(info.error)})`)
  )

  let storageState: StorageState | undefined
  if (storageStatePath) {
    storageState = loadStorageStateFile(storageStatePath)
    if (!storageState) return false
  }

  const credentials = resolveLoginCredentials()
  const secrets = [credentials.username, credentials.password, llmApiKey]

  const effectiveRepeat = Math.min(repeat, HARD_MAX_REPEAT)
  if (repeat > effectiveRepeat) {
    // Disclosed, unlike maxSteps's own silent clamp — --repeat multiplies
    // whole extra LLM-driven runs, a much larger BYOK cost unit than one
    // extra step, and this is new code with no existing gap to match.
    console.log(`\nNote: --repeat ${repeat} exceeds the cap of ${HARD_MAX_REPEAT} — running ${effectiveRepeat} times instead.`)
  }

  console.log(`\nfive46 test: driving a real local browser toward: "${goal}" (repeated ${effectiveRepeat} times, sequentially)`)
  console.log(`This page's visible text/labels/values are sent to ${provider.id} (your own API key) on every step, for every repeat.`)
  if (storageState) console.log(`Starting already authenticated, using the session at ${storageStatePath}.`)
  if (credentials.username || credentials.password) {
    console.log('A login username/password is configured — never sent to the LLM, only used locally if the agent fills a credential field.')
  }
  console.log('Each repeat writes its own generated spec; the run-id header line is ignored when comparing them for flakiness.')
  if (recordVideo) console.log('A full .webm video of each repeat will be recorded to its own artifact directory once that repeat finishes.')
  if (structuredPlan) console.log('Each repeat plans the whole goal upfront with one extra LLM call; most steps then execute without a further live decision.')

  const batchId = Date.now().toString(36)
  const results: RepeatIterationResult[] = []
  for (let i = 1; i <= effectiveRepeat; i++) {
    console.log(`\n=== Repeat ${i}/${effectiveRepeat} ===`)
    const artifactDir = join(process.cwd(), `five46-agent-${batchId}-${i}`)
    const iterationOut = outArg ? insertIterationSuffix(outArg, i) : undefined
    const result = await performOneE2eRun(
      url,
      goal,
      maxSteps,
      headed,
      iterationOut,
      artifactDir,
      storageState,
      allowDeletes,
      noRootCause,
      recordVideo,
      structuredPlan,
      provider,
      llmApiKey,
      credentials,
      secrets,
      projectName,
      fastSteps
    )
    if (result === 'errored') {
      // Don't spend the remaining repeats' BYOK budget once one iteration
      // has already hit a real tooling failure — there's no partial-credit
      // "flaky across the iterations that happened to work."
      console.error(`\nRepeat ${i}/${effectiveRepeat} hit a tooling error — stopping early rather than running the rest.`)
      return false
    }
    results.push({ iteration: i, outcome: result.outcome, specBody: result.specBody })
  }

  const classification = classifyRepeatResults(results)
  const succeededCount = results.filter((r) => r.outcome === 'goal-reached').length
  console.log(
    `\n${succeededCount}/${effectiveRepeat} run(s) reached goal-reached; generated output was ${
      classification.identicalBodies ? 'identical' : 'NOT identical'
    } across all repeats.`
  )
  for (const i of classification.differingIterations) {
    console.log(`\n--- Diff: repeat 1 vs. repeat ${i} ---`)
    console.log(formatDiff(diffSpecFiles(results[0].specBody, results[i - 1].specBody)))
  }
  console.log(
    classification.flaky
      ? `\nFLAKY: this goal did not produce the same outcome/behavior across all ${effectiveRepeat} repeats.`
      : `\nSTABLE: all ${effectiveRepeat} repeats reached goal-reached with identical generated output.`
  )
  return !classification.flaky
}

/** The actual single-run work shared by `runApiTestCommand` (one run) and
 * `runRepeatedApiTestCommand` (`--repeat N` runs) — see `performOneE2eRun`'s
 * doc comment for the identical reasoning, mirrored here for the API
 * engine. */
export async function performOneApiRun(
  baseUrl: string,
  goal: string,
  maxSteps: number | undefined,
  outArg: string | undefined,
  storageState: StorageState | undefined,
  safety: SafetyMode,
  authHeaders: Record<string, string> | undefined,
  noRootCause: boolean | undefined,
  structuredPlan: boolean | undefined,
  provider: LlmProvider,
  llmApiKey: string,
  secrets: (string | undefined)[],
  projectName: string | undefined,
  fastSteps: boolean | undefined
): Promise<{ outcome: RunOutcome; specBody: string } | 'errored'> {
  let run
  try {
    run = await runApiTest({
      baseUrl,
      goal,
      provider,
      apiKey: llmApiKey,
      maxSteps,
      safety,
      authHeaders,
      storageState,
      useStructuredPlan: structuredPlan,
      useFastSteps: fastSteps,
      // Real-time write visibility — printed as it happens, so it must go
      // through the same redaction the final report gets. A resolved URL
      // can legitimately contain a chained saveAs value pulled from a
      // response body (e.g. a token used in a later query param), the same
      // secret-exfiltration channel DEVELOPMENT.md already discloses for
      // the LLM-prompt path — this is the identical value reaching local
      // stdout instead, previously unredacted here (though MCP's own copy
      // of this same callback already redacted correctly — a real drift
      // between the two, now closed).
      onWrite: (method, url, reason) => console.log(`  -> ${redactSecrets(`${method} ${url} (${reason})`, secrets)}`),
    })
  } catch (err) {
    // No browser is involved here, so there's no AgentBrowserUnavailableError
    // equivalent to special-case — any error (a provider exception, a
    // network failure) must still be redacted before printing, same as
    // runE2eTest/runLoginFlow. Unlike those two, this call previously had
    // no try/catch here at all, letting anything thrown reach main()'s own
    // catch-all completely unredacted.
    console.error(`\nfive46 api failed: ${redactSecrets(err instanceof Error ? err.message : String(err), secrets)}`)
    return 'errored'
  }

  let rootCauseHypothesis: string | undefined
  if (run.outcome === 'assertion-failed' && !noRootCause) {
    console.log('\nGenerating a root-cause hypothesis for this failure (one additional LLM call)...')
    rootCauseHypothesis = redactSecrets(await generateApiRootCauseHypothesis(run, provider, llmApiKey), secrets)
  }

  console.log(`\n${redactSecrets(formatApiFailureReport(run, rootCauseHypothesis), secrets)}`)

  const outPath = outArg ?? join(process.cwd(), `five46-api-${run.runId}.test.mjs`)
  let specBody = redactSecrets(generateApiSpec(run), secrets)
  if (projectName) specBody = withProjectHeaderLine(specBody, projectName)
  writeFileSync(outPath, specBody, 'utf8')
  console.log(`\nWrote ${run.steps.filter((s) => s.ok).length} confirmed-working step(s) to ${outPath}`)
  return { outcome: run.outcome, specBody }
}

/**
 * `five46 api <base-url>` — the API/backend-testing counterpart to
 * `five46 test`: an LLM (BYOK) drives real HTTP requests toward a
 * stated goal, one request/assertion at a time, and a real, standalone
 * `node:test` script comes out the other side. No browser, no arbitrary
 * code execution — see DEVELOPMENT.md for the full design rationale
 * (why not a Python-`exec()`-in-a-cloud-sandbox model like some competitors
 * use, the read-only-by-default safety design, the redirect-bypass fix).
 * Read-only (`GET`/`HEAD`/
 * `OPTIONS`) unless `--allow-writes`/`--allow-deletes` are explicitly
 * passed — the user's own explicit call, since an agent with HTTP method
 * freedom has no natural blast-radius ceiling the way a browser click does.
 */
/** Same CI-exit-code contract as `runE2eTest` — see its doc comment. */
async function runApiTestCommand(
  baseUrl: string,
  goal: string,
  maxSteps: number | undefined,
  outArg: string | undefined,
  storageStatePath: string | undefined,
  allowWrites: boolean,
  allowDeletes: boolean,
  allowHosts: string[],
  noRootCause: boolean | undefined,
  structuredPlan: boolean | undefined,
  projectName: string | undefined,
  fastSteps: boolean | undefined
): Promise<boolean> {
  const { llmProvider, llmApiKey } = resolveCredentials()
  if (!llmApiKey) {
    console.error('\nfive46 api requires an LLM API key.')
    console.error(
      'Run `five46 config` to save one, or set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY as environment variables.'
    )
    return false
  }
  const provider = getLlmProvider(llmProvider || 'openai', (info) =>
    console.log(`  (transient error, retrying attempt ${info.attempt + 1}/${info.maxAttempts} in ${info.delayMs}ms: ${info.error instanceof Error ? info.error.message : String(info.error)})`)
  )

  let storageState: StorageState | undefined
  if (storageStatePath) {
    storageState = loadStorageStateFile(storageStatePath)
    if (!storageState) return false
  }

  const authHeaders = resolveApiAuthHeaders()
  // Same reasoning as runE2eTest's secrets list: the LLM key belongs here too.
  const secrets = [...(authHeaders ? Object.values(authHeaders) : []), llmApiKey]

  const targetOrigin = new URL(baseUrl).origin
  const safety: SafetyMode = { allowWrites, allowDeletes, targetOrigin, allowedHosts: new Set(allowHosts) }
  const allowedMethods = ['GET', 'HEAD', 'OPTIONS', ...(allowWrites ? ['POST', 'PUT', 'PATCH'] : []), ...(allowDeletes ? ['DELETE'] : [])]

  console.log(`\nfive46 api: driving real HTTP requests toward: "${goal}"`)
  console.log(`Request/response data — including response bodies, which may contain a live session token or other secret — is sent to ${provider.id} (your own API key) on every step.`)
  console.log(`Allowed methods this run: ${allowedMethods.join(', ')}. Allowed host(s): ${[targetOrigin, ...allowHosts].join(', ')}.`)
  if (storageState) console.log(`Starting already authenticated, using the session at ${storageStatePath}.`)
  if (authHeaders) console.log('An API auth header is configured — attached to every request, never sent to the LLM.')
  if (structuredPlan) console.log('One extra LLM call will plan the whole goal upfront; most steps then execute without a further live decision.')

  const result = await performOneApiRun(baseUrl, goal, maxSteps, outArg, storageState, safety, authHeaders, noRootCause, structuredPlan, provider, llmApiKey, secrets, projectName, fastSteps)
  return result !== 'errored' && result.outcome === 'goal-reached'
}

/** `five46 api <base-url> --goal "..." --repeat N` — the API-engine mirror
 * of `runRepeatedE2eTest`; see its doc comment for the full reasoning
 * (sequential-not-parallel, the flaky-detection rule via
 * `classifyRepeatResults`, the CI exit-code rule). Fully symmetric with the
 * browser engine — there's no structural reason found to build `--repeat`
 * asymmetrically between the two. */
async function runRepeatedApiTestCommand(
  baseUrl: string,
  goal: string,
  maxSteps: number | undefined,
  outArg: string | undefined,
  storageStatePath: string | undefined,
  allowWrites: boolean,
  allowDeletes: boolean,
  allowHosts: string[],
  noRootCause: boolean | undefined,
  structuredPlan: boolean | undefined,
  repeat: number,
  projectName: string | undefined,
  fastSteps: boolean | undefined
): Promise<boolean> {
  const { llmProvider, llmApiKey } = resolveCredentials()
  if (!llmApiKey) {
    console.error('\nfive46 api requires an LLM API key.')
    console.error(
      'Run `five46 config` to save one, or set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY as environment variables.'
    )
    return false
  }
  const provider = getLlmProvider(llmProvider || 'openai', (info) =>
    console.log(`  (transient error, retrying attempt ${info.attempt + 1}/${info.maxAttempts} in ${info.delayMs}ms: ${info.error instanceof Error ? info.error.message : String(info.error)})`)
  )

  let storageState: StorageState | undefined
  if (storageStatePath) {
    storageState = loadStorageStateFile(storageStatePath)
    if (!storageState) return false
  }

  const authHeaders = resolveApiAuthHeaders()
  const secrets = [...(authHeaders ? Object.values(authHeaders) : []), llmApiKey]

  const targetOrigin = new URL(baseUrl).origin
  const safety: SafetyMode = { allowWrites, allowDeletes, targetOrigin, allowedHosts: new Set(allowHosts) }
  const allowedMethods = ['GET', 'HEAD', 'OPTIONS', ...(allowWrites ? ['POST', 'PUT', 'PATCH'] : []), ...(allowDeletes ? ['DELETE'] : [])]

  const effectiveRepeat = Math.min(repeat, HARD_MAX_REPEAT)
  if (repeat > effectiveRepeat) {
    console.log(`\nNote: --repeat ${repeat} exceeds the cap of ${HARD_MAX_REPEAT} — running ${effectiveRepeat} times instead.`)
  }

  console.log(`\nfive46 api: driving real HTTP requests toward: "${goal}" (repeated ${effectiveRepeat} times, sequentially)`)
  console.log(`Request/response data — including response bodies, which may contain a live session token or other secret — is sent to ${provider.id} (your own API key) on every step, for every repeat.`)
  console.log(`Allowed methods this run: ${allowedMethods.join(', ')}. Allowed host(s): ${[targetOrigin, ...allowHosts].join(', ')}.`)
  if (storageState) console.log(`Starting already authenticated, using the session at ${storageStatePath}.`)
  if (authHeaders) console.log('An API auth header is configured — attached to every request, never sent to the LLM.')
  console.log('Each repeat writes its own generated script; the run-id header line is ignored when comparing them for flakiness.')
  if (structuredPlan) console.log('Each repeat plans the whole goal upfront with one extra LLM call; most steps then execute without a further live decision.')

  const results: RepeatIterationResult[] = []
  for (let i = 1; i <= effectiveRepeat; i++) {
    console.log(`\n=== Repeat ${i}/${effectiveRepeat} ===`)
    const iterationOut = outArg ? insertIterationSuffix(outArg, i) : undefined
    const result = await performOneApiRun(baseUrl, goal, maxSteps, iterationOut, storageState, safety, authHeaders, noRootCause, structuredPlan, provider, llmApiKey, secrets, projectName, fastSteps)
    if (result === 'errored') {
      console.error(`\nRepeat ${i}/${effectiveRepeat} hit a tooling error — stopping early rather than running the rest.`)
      return false
    }
    results.push({ iteration: i, outcome: result.outcome, specBody: result.specBody })
  }

  const classification = classifyRepeatResults(results)
  const succeededCount = results.filter((r) => r.outcome === 'goal-reached').length
  console.log(
    `\n${succeededCount}/${effectiveRepeat} run(s) reached goal-reached; generated output was ${
      classification.identicalBodies ? 'identical' : 'NOT identical'
    } across all repeats.`
  )
  for (const i of classification.differingIterations) {
    console.log(`\n--- Diff: repeat 1 vs. repeat ${i} ---`)
    console.log(formatDiff(diffSpecFiles(results[0].specBody, results[i - 1].specBody)))
  }
  console.log(
    classification.flaky
      ? `\nFLAKY: this goal did not produce the same outcome/behavior across all ${effectiveRepeat} repeats.`
      : `\nSTABLE: all ${effectiveRepeat} repeats reached goal-reached with identical generated output.`
  )
  return !classification.flaky
}

/**
 * `five46 login <url>` — reuses the exact same `runAgent()` engine as
 * `test` to perform a login flow once, then captures the resulting
 * authenticated session (cookies + localStorage) to a file `five46 test
 * --storage-state` can load, so a login only has to happen (and be paid for
 * in LLM calls) once per session lifetime, not on every test run. See
 * DEVELOPMENT.md for the full credential-safety design — the model only
 * ever sees placeholder tokens, real substitution happens locally at
 * Playwright-execution time, and verification is forced (not left to the
 * goal's wording) since an unverified false success here would silently
 * mislead every future `test --storage-state` run, not just this one.
 */
/** Unlike `runE2eTest`/`runApiTestCommand`, success here is deliberately
 * *not* just `outcome === 'goal-reached'` — the model can claim
 * goal-reached while `onGoalReached` below still refuses to write a
 * session file (no real cookie/localStorage change, so the claimed
 * success "doesn't look real"). The actual deliverable of this command is
 * the session file; CI success means that file genuinely got written. */
async function runLoginFlow(
  url: string,
  goal: string,
  maxSteps: number | undefined,
  headed: boolean | undefined,
  outPath: string,
  recordVideo: boolean | undefined
): Promise<boolean> {
  const { llmProvider, llmApiKey } = resolveCredentials()
  if (!llmApiKey) {
    console.error('\nfive46 login requires an LLM API key.')
    console.error(
      'Run `five46 config` to save one, or set FIVE46_LLM_PROVIDER/FIVE46_LLM_API_KEY as environment variables.'
    )
    return false
  }
  const provider = getLlmProvider(llmProvider || 'openai', (info) =>
    console.log(`  (transient error, retrying attempt ${info.attempt + 1}/${info.maxAttempts} in ${info.delayMs}ms: ${info.error instanceof Error ? info.error.message : String(info.error)})`)
  )

  const credentials = resolveLoginCredentials()
  if (!credentials.username && !credentials.password) {
    console.error('\nfive46 login requires login credentials.')
    console.error('Set FIVE46_LOGIN_USERNAME and FIVE46_LOGIN_PASSWORD as environment variables.')
    return false
  }
  // The LLM key belongs here too — same gap as runE2eTest/runApiTestCommand.
  const secrets = [credentials.username, credentials.password, llmApiKey]

  if ((credentials.username && goal.includes(credentials.username)) || (credentials.password && goal.includes(credentials.password))) {
    console.error('\nYour --goal text appears to contain the configured username/password in plaintext.')
    console.error(
      'The goal is sent to the LLM on every step — this would defeat the whole point of using placeholder tokens. ' +
        'Rephrase the goal without the actual credential (e.g. "log in using the configured test account").'
    )
    return false
  }

  const fullGoal = `${goal} To log in, fill the username field with the exact literal token %%USERNAME%%, and the password field with the exact literal token %%PASSWORD%%.`

  console.log(`\nfive46 login: driving a real local browser toward: "${goal}"`)
  console.log(`This page's visible text/labels/values are sent to ${provider.id} (your own API key) on every step.`)
  console.log('Your configured username/password are never sent to the LLM — only placeholder tokens are.')

  const runId = Date.now().toString(36)
  const artifactDir = join(process.cwd(), `five46-agent-login-${runId}`)
  if (recordVideo) console.log(`A full .webm video of this session will be recorded to ${artifactDir} once the run finishes.`)

  let sessionWritten = false
  let run
  try {
    run = await runAgent({
      url,
      goal: fullGoal,
      provider,
      apiKey: llmApiKey,
      maxSteps,
      headless: !headed,
      artifactDir,
      credentials,
      forceConfirmation: true,
      recordVideo,
      onGoalReached: async (context, baselineState) => {
        const finalState = await context.storageState()
        const changed = JSON.stringify(finalState) !== JSON.stringify(baselineState)
        if (!changed) {
          console.warn(
            '\nWarning: no cookies or localStorage actually changed during this run — the session the model reported as successful does not look real. Not writing an output file.'
          )
          return
        }
        writeSecureFile(outPath, JSON.stringify(finalState))
        sessionWritten = true
        console.log(
          `\nWrote a live session to ${outPath}. This file can authenticate as this account without a password — treat it like a credential, do not commit it to version control.`
        )
      },
    })
  } catch (err) {
    if (err instanceof AgentBrowserUnavailableError) {
      console.error(`\n${err.message}`)
      return false
    }
    // Same reasoning as runE2eTest: must not let a raw, unredacted error
    // reach main()'s own catch — this run is especially likely to be
    // holding a real, currently-live credential in its own local state.
    console.error(`\nfive46 login failed: ${redactSecrets(err instanceof Error ? err.message : String(err), secrets)}`)
    return false
  }

  console.log(`\n${redactSecrets(formatFailureReport(run), secrets)}`)
  if (run.outcome !== 'goal-reached') {
    console.error('\nLogin did not succeed — no session file was written.')
  }
  return sessionWritten
}

/**
 * `five46 config` — an interactive setup wizard, the same shape as
 * `gh auth login`/`aws configure`/`vercel login`, so credentials don't need
 * to be re-exported as environment variables every session. Saves to
 * `~/.five46/config.json` (see config/store.ts for the file-permissions
 * story); environment variables still exist and always take priority over
 * this file (see config/resolve.ts) — this is a convenience on top, not a
 * replacement.
 */
async function runConfigWizard(): Promise<void> {
  const existing = loadConfigFile() ?? {}
  const config: Five46Config = { ...existing }

  console.log(`This saves your BYOK LLM credentials to ${configFilePath()}.`)
  console.log('Stored as plain JSON with user-only file permissions — not encrypted at rest (the same tradeoff ~/.aws/credentials makes).')
  console.log("Press Enter on a prompt to keep what's already saved (shown in parentheses) or leave it unconfigured.\n")

  const session = createPromptSession()
  try {
    const provider = await session.ask(`LLM provider (${supportedLlmProviderIds().join('/')})`, {
      defaultValue: existing.llm?.provider ?? 'openai',
    })
    const isBedrock = provider === 'bedrock'
    const apiKey = isBedrock
      ? await session.ask('AWS region (e.g. us-east-1) — Bedrock auth comes from your AWS environment/IAM role, not a key entered here', {
          defaultValue: existing.llm?.apiKey,
        })
      : await session.ask(`${provider || 'LLM'} API key`, { mask: true })
    if (provider && apiKey) {
      config.llm = { provider, apiKey }
    }
  } finally {
    session.close()
  }

  saveConfigFile(config)
  console.log(`\nSaved to ${configFilePath()}.`)
}

export function parseDiffArgs(argv: string[]): { fileA?: string; fileB?: string } {
  return { fileA: argv[0], fileB: argv[1] }
}

/** `five46 diff <fileA> <fileB>` — a plain line diff between two files,
 * with the header's run-id token (but not the outcome half of that same
 * line — see diffSpecs.ts's `normalizeRunHeader`) normalized out first.
 * Deliberately takes two file paths, not run-ids resolved against a
 * directory: resolving a bare id would require guessing both a default
 * directory and which of the two generated-file kinds (test/api) was
 * meant — an extra guessing layer this codebase avoids everywhere else
 * (`list` itself requires an explicit `[dir]`, never inventing "the right
 * directory"). `five46 list`'s own output already prints the exact
 * filenames to paste into this command. Accepts any two readable text
 * files, not just five46-generated ones — a plain diff is a strictly more
 * general, still-honest operation, and `normalizeRunHeader` is a no-op on
 * non-matching content. Exit code mirrors Unix `diff`'s own convention:
 * true (exit 0) only when identical after normalization, false (exit 1)
 * when they differ or either file can't be read. */
function runDiffCommand(fileA: string, fileB: string): boolean {
  let contentA: string
  let contentB: string
  try {
    contentA = readFileSync(fileA, 'utf8')
  } catch (err) {
    console.error(`\nCouldn't read "${fileA}": ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  try {
    contentB = readFileSync(fileB, 'utf8')
  } catch (err) {
    console.error(`\nCouldn't read "${fileB}": ${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  const diff = diffSpecFiles(contentA, contentB)
  const changed = diff.some((line) => line.type !== 'context')
  if (!changed) {
    console.log(`\n${fileA} and ${fileB} are identical (ignoring the run-id header line).`)
    return true
  }

  console.log(`\n--- ${fileA}`)
  console.log(`+++ ${fileB}`)
  console.log(formatDiff(diff))
  return false
}

interface ListedRun {
  file: string
  kind: 'test' | 'api'
  runId: string
  goal?: string
  outcome?: string
  project?: string
  mtimeMs: number
}

/** Reads exactly the header comment `generateAgentSpec.ts`/
 * `generateApiSpec.ts` already write into every generated file (`// Goal:
 * ...`, `// Run <id> — outcome: ...`), plus the optional `// Project: ...`
 * line `withProjectHeaderLine` splices in when `--project` was used — no
 * new metadata format, no separate manifest file to keep in sync; the
 * generated artifact already is the record. `runId` comes from the
 * filename itself (`five46-agent-<id>.spec.ts`/`five46-api-<id>.test.mjs`),
 * which is always present even if the file's own content were ever
 * hand-edited. */
function parseGeneratedRunFile(filePath: string): ListedRun | undefined {
  const filename = basename(filePath)
  const testMatch = filename.match(/^five46-agent-(.+)\.spec\.ts$/)
  const apiMatch = filename.match(/^five46-api-(.+)\.test\.mjs$/)
  if (!testMatch && !apiMatch) return undefined

  let content: string
  let mtimeMs: number
  try {
    content = readFileSync(filePath, 'utf8')
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    return undefined
  }
  const goal = content.match(/^\/\/ Goal: (.*)$/m)?.[1]
  const outcome = content.match(/outcome: (\S+)/)?.[1]
  const project = content.match(/^\/\/ Project: (.*)$/m)?.[1]

  return { file: filename, kind: testMatch ? 'test' : 'api', runId: (testMatch ?? apiMatch)![1], goal, outcome, project, mtimeMs }
}

/** Splices `// Project: <name>` right after the header's existing
 * `// Run <id> — outcome: ...` line (matched by regex, not a fixed line
 * index, so header-shape drift degrades to "untagged" rather than
 * crashing the whole write — returns `specBody` unchanged if the expected
 * line isn't found). Deliberately a `cli.ts`-local post-processing step
 * on the already-generated string, not a new parameter on
 * `generateAgentSpec`/`generateApiSpec` themselves — keeps `TestRun`/
 * `ApiTestRun` and both generators completely unaware project-management
 * exists at all. */
export function withProjectHeaderLine(specBody: string, projectName: string): string {
  const pattern = /^(\/\/ Run \S+ — outcome: [^\n]*)$/m
  if (!pattern.test(specBody)) return specBody
  return specBody.replace(pattern, `$1\n// Project: ${projectName}`)
}

export function parseListArgs(argv: string[]): { dir?: string; project?: string } {
  const result: { dir?: string; project?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') {
      result.project = argv[++i]
    } else if (!result.dir) {
      result.dir = argv[i]
    }
  }
  return result
}

/** `five46 list [dir] [--project name]` — lists previously generated runs
 * in a directory (default: cwd), most recent first, optionally filtered
 * to one project. Deliberately does not attempt "rerun" as a separate
 * feature: every generated file already *is* a real, standalone,
 * re-runnable Playwright/node:test file (see each generator's own header
 * comment) — `npx playwright test <file>`/`node --test <file>` already is
 * the rerun command, with no five46/LLM involved. Read-only, purely
 * additive — no new file format, no state five46 has to keep in sync with
 * the generated artifacts themselves. */
function listGeneratedRuns(dir: string, projectFilter?: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    console.error(`\nCouldn't read directory "${dir}": ${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  let runs = entries
    .map((name) => parseGeneratedRunFile(join(dir, name)))
    .filter((r): r is ListedRun => r !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (projectFilter) runs = runs.filter((r) => r.project === projectFilter)

  const label = dir === '.' ? 'the current directory' : dir
  if (runs.length === 0) {
    // Names the project explicitly when filtering, so an empty *filtered*
    // result reads distinctly from "the filter itself didn't work."
    const projectNote = projectFilter ? ` for project "${projectFilter}"` : ''
    console.log(`\nNo generated five46 runs${projectNote} found in ${label}.`)
    console.log('("five46 test"/"five46 api" write five46-agent-<id>.spec.ts / five46-api-<id>.test.mjs on every run.)')
    return true
  }

  console.log(`\n${runs.length} generated run(s) in ${label}, most recent first:\n`)
  for (const run of runs) {
    const outcomeLabel = run.outcome === 'goal-reached' ? 'succeeded' : (run.outcome ?? 'unknown')
    const projectLabel = run.project ? ` [project: ${run.project}]` : ''
    console.log(`  [${run.kind}] ${run.file}  (${outcomeLabel})${projectLabel}`)
    if (run.goal) console.log(`      goal: "${run.goal}"`)
  }
  console.log('\nRe-run any of these directly, no five46/LLM involved:')
  console.log('  npx playwright test <file>   # for a five46-agent-*.spec.ts file')
  console.log('  node --test <file>           # for a five46-api-*.test.mjs file')
  return true
}

const USAGE = [
  'Usage: five46 test <url> --goal "text" [--max-steps N] [--headed] [--out path] [--storage-state path] [--allow-deletes] [--no-root-cause] [--repeat N] [--project name] [--record-video] [--no-structured-plan] [--fast-steps]',
  '       five46 login <url> --goal "text" --out <path> [--max-steps N] [--headed] [--record-video]',
  '       five46 api <base-url> --goal "text" [--allow-writes] [--allow-deletes] [--allow-host <host>]... [--storage-state path] [--max-steps N] [--out path] [--no-root-cause] [--repeat N] [--project name] [--no-structured-plan] [--fast-steps]',
  '       five46 mcp   (starts an MCP server on stdio, exposing five46_test/five46_api to an IDE-embedded AI assistant)',
  '       five46 list [dir] [--project name]   (lists previously generated runs, default: current directory)',
  '       five46 diff <fileA> <fileB>   (line diff between two generated run files, ignoring the run-id header line)',
  '       five46 config   (interactive BYOK credential setup)',
].join('\n')

/** Resolves `--project` (if given) against `five46.config.json` and merges
 * its defaults into the already-parsed flags — an explicit CLI flag always
 * wins. Exits the process with a clear, actionable message on any problem
 * (no config file present, invalid JSON, wrong shape, unknown project
 * name) rather than silently proceeding as if `--project` had been
 * ignored — matching this codebase's "never guess" posture elsewhere. */
function resolveProjectForTest(parsed: ParsedAgentArgs): ParsedAgentArgs {
  if (!parsed.project) return parsed
  const loaded = loadProjectConfig()
  if (!loaded.ok) {
    console.error(`\n${loaded.error}`)
    process.exit(1)
  }
  const resolved = resolveProject(loaded.config, parsed.project)
  if (!resolved.ok) {
    console.error(`\n${resolved.error}`)
    process.exit(1)
  }
  return mergeProjectDefaultsForTest(parsed, resolved.defaults)
}

function resolveProjectForApi(parsed: ParsedApiArgs): ParsedApiArgs {
  if (!parsed.project) return parsed
  const loaded = loadProjectConfig()
  if (!loaded.ok) {
    console.error(`\n${loaded.error}`)
    process.exit(1)
  }
  const resolved = resolveProject(loaded.config, parsed.project)
  if (!resolved.ok) {
    console.error(`\n${resolved.error}`)
    process.exit(1)
  }
  return mergeProjectDefaultsForApi(parsed, resolved.defaults)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === 'config') {
    await runConfigWizard()
    return
  }

  if (argv[0] === 'login') {
    const { url, goal, maxSteps, headed, out, recordVideo } = parseAgentArgs(argv.slice(1))
    if (!url || !goal || !out) {
      console.error(USAGE)
      process.exit(1)
    }
    if (!validateTargetUrl(url)) process.exit(1)

    try {
      const succeeded = await runLoginFlow(url, goal, maxSteps, headed, out, recordVideo)
      if (!succeeded) process.exit(1)
    } catch (err) {
      console.error(`\nfive46 login failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    return
  }

  if (argv[0] === 'mcp') {
    // @modelcontextprotocol/sdk + zod are optionalDependencies, exactly
    // like playwright — a user who only ever runs test/login/api must
    // never pay a require() cost for either. Everything under `src/mcp/`
    // uses normal top-level imports internally; this is the one, single
    // lazy boundary into that whole subtree (see `mcp/server.ts`'s own
    // doc comment for why the boundary is drawn here rather than inside
    // each individual file).
    try {
      const { createFive46McpServer } = require('./mcp/server') as typeof import('./mcp/server')
      const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as typeof import('@modelcontextprotocol/sdk/server/stdio.js')
      const { server } = createFive46McpServer()
      await server.connect(new StdioServerTransport())
      // stderr only — stdio's stdout is the literal JSON-RPC transport
      // channel for this server; anything printed to stdout here would
      // corrupt the protocol stream for whatever client just connected.
      console.error('five46 mcp: server running on stdio')
    } catch (err) {
      console.error(
        `\nfive46 mcp needs the optional @modelcontextprotocol/sdk + zod dependencies — install with: npm install --save-dev @modelcontextprotocol/sdk zod\n(${err instanceof Error ? err.message : String(err)})`
      )
      process.exit(1)
    }
    return
  }

  if (argv[0] === 'list') {
    const { dir, project } = parseListArgs(argv.slice(1))
    if (!listGeneratedRuns(dir ?? process.cwd(), project)) process.exit(1)
    return
  }

  if (argv[0] === 'diff') {
    const { fileA, fileB } = parseDiffArgs(argv.slice(1))
    if (!fileA || !fileB) {
      console.error(USAGE)
      process.exit(1)
    }
    if (!runDiffCommand(fileA, fileB)) process.exit(1)
    return
  }

  if (argv[0] === 'api') {
    const { baseUrl, goal, maxSteps, out, storageState, allowWrites, allowDeletes, allowHosts, noRootCause, repeat, project, noStructuredPlan, fastSteps } = resolveProjectForApi(
      parseApiArgs(argv.slice(1))
    )
    const structuredPlan = resolveStructuredPlan({ noStructuredPlan })
    if (!baseUrl || !goal) {
      console.error(USAGE)
      process.exit(1)
    }
    if (!validateApiBaseUrl(baseUrl)) process.exit(1)

    try {
      // repeat === 1 (or unset) is an ordinary single run, not an error —
      // a legitimate if pointless value; only >= 2 actually engages the
      // repeated/flaky-detection path.
      const succeeded =
        repeat !== undefined && repeat >= 2
          ? await runRepeatedApiTestCommand(baseUrl, goal, maxSteps, out, storageState, allowWrites, allowDeletes, allowHosts, noRootCause, structuredPlan, repeat, project, fastSteps)
          : await runApiTestCommand(baseUrl, goal, maxSteps, out, storageState, allowWrites, allowDeletes, allowHosts, noRootCause, structuredPlan, project, fastSteps)
      if (!succeeded) process.exit(1)
    } catch (err) {
      console.error(`\nfive46 api failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    return
  }

  if (argv[0] !== 'test') {
    console.error(USAGE)
    process.exit(1)
  }

  const { url, goal, maxSteps, headed, out, storageState, allowDeletes, noRootCause, repeat, project, recordVideo, noStructuredPlan, fastSteps } = resolveProjectForTest(
    parseAgentArgs(argv.slice(1))
  )
  const structuredPlan = resolveStructuredPlan({ noStructuredPlan })
  if (!url || !goal) {
    console.error(USAGE)
    process.exit(1)
  }

  if (!validateTargetUrl(url)) process.exit(1)

  try {
    const succeeded =
      repeat !== undefined && repeat >= 2
        ? await runRepeatedE2eTest(url, goal, maxSteps, headed, out, storageState, allowDeletes, noRootCause, recordVideo, structuredPlan, repeat, project, fastSteps)
        : await runE2eTest(url, goal, maxSteps, headed, out, storageState, allowDeletes, noRootCause, recordVideo, structuredPlan, project, fastSteps)
    if (!succeeded) process.exit(1)
  } catch (err) {
    console.error(`\nfive46 test failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// Only run when executed directly (`node dist/cli.js ...`), not when
// imported as a module — needed so `cli.test.ts` can import `parseAgentArgs`
// without triggering a full CLI run (against the test runner's own argv) as
// an import side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
