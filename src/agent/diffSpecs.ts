/** Pure line-diffing for two five46-generated run files (`.spec.ts`/
 * `.test.mjs`), or really any two small text files — no fs access here,
 * so this is usable both by `five46 diff` (cli.ts) and by `--repeat`'s
 * flaky classifier (flaky.ts), which diffs in-memory generated spec
 * bodies before either is ever written to disk. */

export interface DiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
}

/** Classic O(n·m) LCS-based line diff. No new npm dependency — this
 * project has added zero new deps for any CLI feature so far (only
 * @modelcontextprotocol/sdk/zod, and those are optional, `mcp`-only). The
 * inputs this is designed for are always five46-generated files — tens of
 * lines, never megabytes — so the O(n·m) table is never a real cost; this
 * doesn't claim to be a general-purpose diff tool that would need one. */
export function computeLineDiff(linesA: string[], linesB: string[]): DiffLine[] {
  const n = linesA.length
  const m = linesB.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = linesA[i] === linesB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) {
      result.push({ type: 'context', text: linesA[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: linesA[i] })
      i++
    } else {
      result.push({ type: 'add', text: linesB[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: linesA[i] })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: linesB[j] })
    j++
  }
  return result
}

// Matches generateSpec.ts/generateApiSpec.ts's header line 3 exactly:
// `// Run <runId> — outcome: <outcome>`. Only the run-id token is replaced,
// not the whole line dropped — dropping the line would also hide the
// outcome half, which --repeat's flaky detection needs visible as a real
// diff (two iterations that both reached goal-reached but produced
// different runIds must NOT look like a difference; two iterations with
// different *outcomes* must). Harmless no-op on any text that doesn't
// contain this exact pattern, so diffing two arbitrary, non-five46 files
// still degrades gracefully to a plain line diff.
const RUN_HEADER_PATTERN = /^(\/\/ Run )(\S+)( — outcome: )/m

export function normalizeRunHeader(content: string): string {
  return content.replace(RUN_HEADER_PATTERN, '$1<run-id>$3')
}

export function diffSpecFiles(contentA: string, contentB: string): DiffLine[] {
  return computeLineDiff(normalizeRunHeader(contentA).split('\n'), normalizeRunHeader(contentB).split('\n'))
}

/** Unified-diff-*style* (leading +/-/space per line) — not a literal patch
 * file: no @@ hunk headers, no line numbers, no context windowing. These
 * files are always small, so hunk-collapsing buys nothing; this matches
 * formatFailureReport's own precedent of printed reports being
 * human-readable text blocks, not machine-parseable diagnostic formats. */
export function formatDiff(diffLines: DiffLine[]): string {
  return diffLines
    .map((line) => {
      const prefix = line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '
      return `${prefix}${line.text}`
    })
    .join('\n')
}
