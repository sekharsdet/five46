# Security Policy

five46 runs fully on your own machine and handles real credentials — your
LLM provider API key, and optionally login credentials for the app you're
testing. If you find a way those could leak, be mishandled, or otherwise
be put at risk, please report it privately rather than opening a public
issue.

## Reporting a vulnerability

Email **qesekhar@gmail.com** with a description of the issue and, if
possible, steps to reproduce it. You can also use
[GitHub's private vulnerability reporting](https://github.com/sekharsdet/five46/security/advisories/new)
on this repository instead.

Please don't open a public GitHub issue for a security report until
there's been a chance to look into it and, ideally, ship a fix.

## What's in scope

- Credential/secret handling: how the LLM API key, login username/password,
  and any API auth headers are stored, redacted from output, or sent
  (including whether anything reaches somewhere it shouldn't — the only
  intended destination for app/API data is the LLM provider you configured,
  and that's always disclosed up front by the CLI itself).
- The safety gates around `five46 api` (read-only by default,
  `--allow-writes`/`--allow-deletes` required to unlock writes/deletes) and
  `five46 test` (destructive-click blocking by default) — anything that
  lets those be bypassed.
- The MCP server's own environment-variable-gated unlocks
  (`FIVE46_MCP_ALLOW_WRITES`/`FIVE46_MCP_ALLOW_DELETES`) — anything that
  lets a tool call unlock writes/deletes without the env var actually
  being set.

## What's out of scope

- The LLM provider itself deciding to do something unexpected with a
  prompt — that's a provider-side concern, not a five46 vulnerability,
  though if five46 is disclosing more to the model than it needs to
  (or than the docs claim it does), that's very much in scope.
- Vulnerabilities in the app/API you're pointing five46 at — that's your
  own target, not this project.

## Response

This is a small, mostly-solo project — there's no formal SLA, but real
security reports get priority over everything else in the queue.
