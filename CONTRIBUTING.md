# Contributing to five46

Thanks for taking a look. This is a small, mostly-solo project, so the bar
here is "make it easy for me to say yes," not a formal process.

## Building and testing locally

```bash
git clone https://github.com/sekharsdet/five46.git
cd five46
npm install
npm run build
```

- `npm test` — builds, then runs the full test suite (`node --test`).
  Browser-driven tests need Chromium installed
  (`npx playwright install chromium`) and will skip themselves cleanly if
  it isn't available.
- `npm run eval` — runs `src/eval/`'s persistent regression corpus against
  real sites using a real LLM key (see "Adding an eval case" below).
  Deliberately **not** part of `npm test`: it spends real BYOK budget and
  depends on third-party sites staying up, so it's opt-in and explicit.
- `npm run dev` — runs the CLI straight from TypeScript via `ts-node`, for
  quick manual iteration without a build step.

## Code conventions

The codebase leans heavily on doc comments that explain *why*, not *what*
— usually citing the specific real, live-found gap that motivated a piece
of logic (a site that broke an assumption, a bug reproduced against a real
target, a tradeoff that was deliberately made one way over another). A
comment that only restates what the code already says is not the
convention here; if you can't point to a real reason, it probably doesn't
need a comment at all.

Several source files reference an internal `DEVELOPMENT.md` for "the full
design rationale" on certain features — that file is intentionally not
committed (see `.gitignore`), so you won't have it locally. It doesn't
hold anything you need to contribute: the doc comments next to the actual
code, this file, and `CHANGELOG.md` are the public record of why things
are the way they are. If a doc comment's reasoning genuinely isn't
followable without it, that's worth flagging as its own issue.

## Adding an eval case

`src/eval/cases.ts` is a checked-in, re-runnable corpus of real interaction
patterns — the standing answer to "we keep re-discovering the same class
of gap on every new site." If you find a real site/interaction pattern
five46 handles wrong, the most useful contribution is usually a new
`EvalCase` entry that reproduces it (a `goal`, a `target`, an
`expectedOutcome` if it isn't the default `'goal-reached'`), even before
there's a fix — it turns a one-off bug report into a permanent regression
check once someone (possibly you) does fix it.

## Sending a PR

- Keep it focused — one real change per PR is easier to review and easier
  to revert if it's wrong.
- Add or update tests for behavior you're changing; `npm test` should pass
  cleanly (aside from any test the CI machine itself can't run, like
  browser-driven tests with no Chromium installed).
- Explain the *why* in the PR description the same way the codebase's own
  comments do — what was actually broken or missing, and how you confirmed
  it, not just what changed.

## Reporting a bug

Please include: the exact command/goal you ran, what you expected vs. what
happened, and — if you're comfortable sharing it — the generated spec file
or printed report (redact anything sensitive first; five46 already
redacts known secrets from its own output, but double-check).

See [SECURITY.md](./SECURITY.md) instead if what you found is a security
issue rather than a functional bug.
