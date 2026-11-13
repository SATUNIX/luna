# Provider failures and model fit

How Luna keeps a session going when a provider refuses a request, a small model stalls, or the model
runs on your own machine. Everything here is on by default where it costs nothing and is a no-op
otherwise.

## Provider failures

`finish-reason-retry` classifies every failed model reply once: **credit** (HTTP 402 and its
wordings), **rate limit** (429), **server** (5xx, overloaded) or other. The same classifier is used by
the provider-router fallback list and by the autonomy runner (`packages/extensions/src/finish-reason-retry/provider-errors.ts`).

- A 402 that says how many output tokens the account can still afford ("can only afford 1234") is
  retried with the output maximum held at 90% of that figure. Each retry needs a strictly lower
  figure, and below 256 tokens the failure is terminal, so it cannot loop. The clamp applies to that
  model for the rest of the session.
- Provider text shown to you is redacted: links (which can carry a key in the query string) and
  `key=`, `token=` and `secret=` parameters are removed.
- **Fallback list.** `PI_KIT_ROUTING_POLICY` may name `"fallback": ["provider/model", ...]` (at most
  three). On a credit, rate-limit or server failure the session moves to the first listed model that
  is not cooling down, and pi retries the turn on it once the model switch has finished. A failed model cools down for five minutes and
  is returned to afterwards. A policy file with only `fallback` is valid (no task routing). Needs the
  `provider-router` extension, which is in no profile by default.
- In an autonomous run a credit failure that no clamp or fallback can fix parks the run as blocked
  ([Autonomy](autonomy.md)); a clampable one is left to the retry above once, and parks the run when it
  comes back a second time in a row (the request may have had no output maximum to lower).

Pinned by `npm run smoke:provider-resilience`. Not covered: per-role fallback chains, and switching
back mid-turn (the return to the first model happens at the start of the next turn).

## Stalled turns

Also in `finish-reason-retry`, loaded in every profile:

- **Empty turn.** A reply with no text and no tool call is answered with one short steer ("call a
  tool, or say what you are blocked on"), at most twice per user message. A new message resets the count.
- **Tool-argument errors.** pi's own message echoes the whole rejected argument object. The model now
  sees the bad fields with the reason, the tool's required and optional keys, and an instruction to call
  again; a call cut off mid-JSON says so.

Pinned by `npm run smoke:provider-resilience`. Not covered: repairing a tool call a model wrote as
text, and retrying a truncated call; neither has recorded cases yet.

## Local models

A model is *local* when its provider's `baseUrl` is loopback, a private (RFC 1918) address, a
`.local`, `.lan` or `.internal` name, or a bare host name. Price is not used, because hosted free
tiers cost nothing too. This is judged from the address alone, so a private gateway in front of a hosted
model also looks local; `PI_KIT_LOCAL_MODELS=off` turns the rule off (`on` forces it) for all three
effects below.

- **Auto-mode judge.** A local judge waits 90 seconds (hosted: 15) and is not asked a second time
  (a timeout is uncertain, so the action goes to you); the first request often pays for loading the model. If two
  judgements in a row time out you are told once. `PI_KIT_FIREWALL_JUDGE_TIMEOUT_MS` still overrides.
  Wrapped answers (a markdown fence, a `<think>` block, single quotes, a trailing comma) are read; prose
  with no JSON verdict is not. The last verdict object in the answer decides, `allow` must be exact
  lowercase (`block` is read in any case), and an object with double quotes is not repaired.
- **Subagents and workflows.** Children run one at a time on a local model. `maxConcurrentRequests`
  on the model or provider in `models.json` sets another number (for any provider), and
  `PI_KIT_SUBAGENT_CONCURRENCY` overrides both. Background launches and script workflows are not
  limited by this.
- **Tool-call probe (opt-in).** With `PI_KIT_TOOL_PROBE=1`, the first time a local model is selected
  one request offers it a trivial tool and records whether it called it, in
  `<agent dir>/pi-kit/tool-probe.json`. It is off by default because the request carries the provider's
  auth headers and "local" is a guess. The Doctor page (`/menu`, System, Updates & health) shows the result per model. A server that cannot be
  reached records nothing and is tried again next time.

Pinned by `npm run smoke:judge` and `npm run smoke:model-fit`.

## Model fit

`modelFit(contextWindow)` (`packages/extensions/src/session-helpers/model-fit.ts`) turns a window
size into compaction settings: tiny (under 12k), small (under 48k) or normal (pi's own defaults). The
reserve and keep it suggests leave a compaction threshold that clears keep plus pi's 4k safety margin;
for a window of about 5.8k or less no setting does, and `/compaction status` says to use a larger
window instead. `/compaction status` is its only consumer. Pinned by `npm run smoke:model-fit`.

## The auto-mode judge's input

The judge sees the operator's own messages, the session goal, the actions taken so far (tool and
outcome, not their output), the pending call with what the classifier found about it, the session's
approvals and past decisions. It never sees tool results, web or file content, or the model's own
text and reasoning. Pinned by `npm run smoke:judge`.
