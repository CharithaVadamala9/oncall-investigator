# oncall-investigator

An AI agent on Cloudflare Workers that investigates infrastructure incidents —
correlates logs, metrics, and deploys to find root cause. Not a dashboard, not
a viewer: it decides what to look at next, and it can be wrong or incomplete
about it, honestly.

**Live:** https://oncall-investigator.charitha-vadamala-99.workers.dev/

## What it does

The project is self-contained: a hand-rolled 3-service demo app (`frontend` →
`checkout-service` → `payment-service`) is both the thing being monitored and
the test harness. Traffic runs continuously on a schedule. A seeded incident —
a real deploy event, followed by a real latency/error regression in
`payment-service` — gives a known, gradeable ground truth: which service,
what deploy, what time window, what the numbers looked like before and after.
Every investigation the agent runs against that incident can be checked
against the known answer, which is what makes this a test suite rather than
a demo that just "looks plausible."

An investigator agent — a hand-rolled tool-calling loop against
`@anthropic-ai/sdk` (Claude Sonnet), *not* a framework — has five read-only
tools to inspect that system: list known services, pull aggregated logs,
query latency/error metrics, check deploy history, and compare against
known-normal baselines. You describe a symptom in the chat UI; it decides
which tools to call and in what order, subject to a hard step budget, and
either finds the root cause or honestly says it couldn't.

## Try it

1. Open the [live URL](https://oncall-investigator.charitha-vadamala-99.workers.dev/).
2. Seed the ground truth (one-time, or repeat any time to re-run the scenario):
   ```
   curl -X POST https://oncall-investigator.charitha-vadamala-99.workers.dev/admin/seed-baselines
   curl -X POST https://oncall-investigator.charitha-vadamala-99.workers.dev/admin/start-traffic
   curl -X POST https://oncall-investigator.charitha-vadamala-99.workers.dev/admin/seed-incident
   ```
3. In the chat UI, ask something like: *"checkout-service is timing out for users right now. What's going on?"*
4. Watch the tool-call trace stream in, then the final answer. Expected
   answer shape: checkout-service's `504`s are a symptom; the actual
   regression is in `payment-service`, correlated with the seeded deploy.

`/admin/stop-traffic` stops the background traffic generator when you're done.

## Architecture

```
                          ┌─────────────────────────┐
   browser (chat UI) ───▶│  Investigator (DO)       │
   WebSocket             │  hand-rolled tool loop   │───▶ Anthropic API
                          │  vs @anthropic-ai/sdk    │
                          └───────────┬─────────────┘
                                      │ executeTool()
                          ┌───────────▼─────────────┐
                          │  5 read-only tools       │
                          └─┬───────┬───────┬────────┘
                            │       │       │
                         D1 (logs) KV (deploys, faults, baselines)  Analytics Engine (metrics)
                            ▲       ▲
                            │       │
                          ┌─┴───────┴─────────────┐
                          │  TrafficGenerator (DO) │──▶ frontend → checkout-service → payment-service
                          │  scheduled every 15s   │    (in-process calls, one Worker — see below)
                          └────────────────────────┘
```

**Runtime**: Cloudflare Agents SDK (Durable Objects) for state, WebSocket
streaming, and scheduling — but *not* its opinionated tool-calling harness.
**Reasoning**: a hand-written loop directly against `@anthropic-ai/sdk`, not
LangChain/CrewAI/Strands. This was a hard constraint, not a preference: the
grading criteria is "how the loop is driven, how context is managed, what
happens when a tool fails," which has to be code that's actually ours to
defend, not a framework's black box.

**The demo app is simulated in-process, not three real Worker-to-Worker
hops.** `frontend`, `checkout-service`, and `payment-service` are plain async
functions called directly in sequence within one Worker, not separate
deployments joined by real `fetch()` calls. Each hop still measures real
wall-clock latency, writes a real D1 log row, and writes a real Analytics
Engine data point — the data is genuine, just without literal network
round-trips between isolates. This was a deliberate simplification for a
one-day build, chosen over standing up real service bindings for the sake of
topology fidelity nobody would actually query for.

**checkout-service's own measured latency includes payment-service's**,
because checkout's handler blocks on the `await` to payment — this is exactly
what makes the seeded incident work: payment-service getting slow shows up as
checkout-service's *own* latency ballooning and its requests timing out,
even though checkout's code never changed. That's the mechanism that forces
the agent to traverse services rather than read one table and stop.

## The five tools

All read-only. No tool does correlation on the agent's behalf — that
intelligence has to live in the model's reasoning, not in a tool, or the
build reduces to "a single fancy prompt with a database attached."

| Tool | Args | Reads from | Notes |
|---|---|---|---|
| `list_services` | — | D1 | `SELECT DISTINCT service` — no separate services table for a static 3-row list |
| `get_metrics` | `service, window_minutes` | Analytics Engine (SQL API) | p50/p95/p99 latency, error rate, request count |
| `get_logs` | `service, since_minutes_ago, until_minutes_ago?, level?, limit?` | D1 | Aggregated counts (uncapped) + a capped, error-prioritized sample (default 20, max 50) — never a raw dump |
| `get_deploys` | `service, since_minutes_ago` | KV | Deploy timeline for that service |
| `get_baseline` | `service` | KV | Known-normal ranges, so the agent can say what's *abnormal*, not just report numbers |

Every time-range argument is **relative** (minutes ago / a window in
minutes), not absolute epoch timestamps. That wasn't the original design —
see [Bugs found during testing](#bugs-found-during-testing) below for why it
changed, and why the fix removes an entire failure mode rather than just
shrinking it.

## Agent loop & guardrails

Guided loop, not a rigid state machine: the system prompt suggests an
investigative order (`list_services` first, metrics/logs before drilling in,
deploys and baselines to confirm), but the model's own tool selection
decides the actual path per investigation.

- **Step cap**: 8 tool calls max, counted per individual tool execution (a
  single turn can request several in parallel). Hitting it doesn't just cut
  the model off — it makes one final call with `tools` omitted entirely
  (forcing a text-only reply, since this SDK version has no
  `tool_choice: "none"`), so the model produces a coherent "here's what I
  found, investigation incomplete" summary instead of an abrupt stop.
- **Duplicate-call short-circuit**: identical tool + identical arguments
  called twice in one investigation is treated as a stuck-loop signal and
  routed through the same graceful-wrap-up path as the step cap — not just
  a skipped call, the whole investigation ends there.
- **Structured tool failures**: every tool returns `{error: "..."}` rather
  than throwing (bad params, no data for range, etc.), and failed results are
  flagged `is_error: true` on the `tool_result` block so the model reliably
  recognizes a failed call rather than parsing JSON to guess.
- **Context management**: `get_logs` always returns aggregated counts plus a
  capped, error-prioritized sample — never an unbounded dump into the
  context window.
- **Read-only, explicitly**: the system prompt states outright that the
  agent cannot take any action — recommendations only, never claims of
  having acted. All 5 tools are read-only by design, matching the dominant
  pattern in the current AI-SRE market (Cleric, HolmesGPT). **Forward-looking
  boundary**: a write tool (e.g. `rollback_deploy`) is not implemented in
  this build, and if it were, it would require explicit human confirmation
  before execution — that's a design line worth stating even though nothing
  on the other side of it exists yet.

## Seeded incident: ground truth & test results

**Ground truth** (reproducible via `/admin/seed-incident`): a `payment-service`
deploy (`v1.4.2`, "connection pool resize") is recorded 5 minutes before a
10-minute fault window opens. During that window, `payment-service` gets
~2000ms slower and fails ~25% of requests. The symptom surfaces at
`checkout-service` as `504`/`downstream_timeout` — not at `payment-service`
directly — which is what forces the agent to traverse the service graph
instead of reading one table.

**What the agent actually found**, in a real run against this scenario:

- Recognized a **~48x latency regression** at `payment-service` (baseline p95
  ~44ms vs. ~2100ms during the incident) by calling `get_baseline` and
  comparing — the tool doesn't compute this itself, the model does.
- Matched the exact `trace_id` between a `checkout-service` failure and the
  corresponding `payment-service` log entry to prove the causal link was a
  specific traced request, not a coincidence of timing.
- Correctly named `checkout-service`'s errors as a symptom and pivoted to
  investigate `payment-service`, then correlated the timing of the `v1.4.2`
  deploy against the onset of the regression.
- Landed on the right root cause using **7 of the available 8 tool calls** —
  `list_services`, `get_metrics`(checkout), `get_logs`(checkout),
  `get_metrics`(payment), `get_logs`(payment), `get_deploys`(payment),
  `get_baseline`(payment) — wrapping up on its own via a normal answer
  rather than being cut off by the step cap.

## Bugs found during testing

These were caught by actually running the agent against live seeded data —
locally, then against the real deployment — not by code review or
typechecking. Listed because the fix is more informative than the bug: each
one is a case where testing surfaced something no amount of reading the code
would have.

- **Timestamp drift.** `get_logs`/`get_deploys` originally took absolute
  epoch-ms `since`/`until`, and the system prompt gave "current time" as an
  ISO string for the model to do its own arithmetic against. Across one
  investigation, the model computed two `since` values a full year apart. Fix
  wasn't "give it the epoch number instead" — it was redesigning both tools
  to take `since_minutes_ago`/`until_minutes_ago` (matching `get_metrics`'s
  existing `window_minutes`), which removes the model's need to reason about
  wall-clock time for *any* tool, rather than just reducing the odds of
  getting it wrong.
- **No pivot.** The agent correctly recognized a `downstream_timeout` as "not
  my bug" but then spent its entire tool budget re-examining the symptomatic
  service instead of investigating the dependency it was blocked on. Fixed
  with an explicit, *generalized* reasoning instruction in the system prompt
  ("if a service's errors point to a dependency it calls, pivot there and
  keep following the chain") — deliberately not hardcoded to this incident's
  specific topology, since a prompt fix that only works for one seeded
  scenario isn't a fix.
- **A ground-truth-corrupting label.** `payment-service`'s own simulated
  random failures were tagged `errorType: "upstream_5xx"` — correct phrasing
  for `checkout-service` (which has a real downstream), wrong for
  `payment-service` (which has none in this topology). It caused the model to
  confidently hallucinate a fourth, nonexistent service ("a payment gateway
  not visible in our tracked service list"). Renamed to `internal_error`;
  confirmed in a follow-up run that the model now correctly states it found
  no further downstream dependency, instead of inventing one.
- **Markdown rendering bugs in the chat UI**, found once the raw-text
  placeholder was replaced with an actual (small, dependency-free) renderer:
  headers immediately followed by body text on the next line (no blank line)
  weren't recognized, because the parser only checked whole paragraph
  blocks; and numbered/bulleted list items that Claude blank-line-separates
  — which it does often — each rendered as their own single-item list
  instead of one continuous list. Both fixed and confirmed against the exact
  failing text, plus a fresh end-to-end browser run.

Smaller fixes along the way: a missing `is_error` flag on failed tool
results, a state-corruption risk if the WebSocket closed mid-investigation
(unresolved `tool_use` blocks would persist with no matching `tool_result`,
permanently breaking that session), and `max_tokens` too low (1024),
confirmed by an actual truncated final answer in testing and raised to 2048.

## Scope: what's excluded, and why

- **No Grafana/Prometheus integration.** The Grafana MCP server and Grafana
  Cloud's free tier both exist and would work — but standing them up is
  disproportionate setup time next to a one-day build. Real next step, not a
  dismissal.
- **No OpenTelemetry Demo app.** Its fault-injection pattern (a KV/flagd-style
  flag) is genuinely good and was borrowed deliberately — but its
  Docker/Kubernetes deployment shape doesn't fit an edge runtime, and standing
  up infrastructure whose only job is generating test data isn't where the
  day's time budget should go.
- **No cloud dependency mapper or full distributed-trace analyst.** Different,
  equally hard problems from log/metric/deploy correlation. Better to do one
  investigation style well than three shallowly.
- **No LangChain/CrewAI/Strands or any agent-orchestration framework.** Hard
  constraint, not a preference — the loop has to be code that's actually ours
  to explain and defend line-by-line, which a framework's internals aren't.
- **No write/action tools**, in this build or as a "confirm-then-execute"
  variant — see the forward-looking boundary note above. Read-only end to end.
- **No auth, rate limiting, or billing controls** — explicitly out of scope
  per the brief. Concretely, that means the `/admin/*` and `/debug/*` routes
  on the live deployment are unauthenticated; fine for a take-home reviewed
  by a known audience, a real gap the moment this were exposed more broadly.

## Known limitations

- **Analytics Engine has a real local/remote split.** Writes work under
  `wrangler dev --local`, but reads only work against the live SQL API
  against real remote data — there's no local emulation for AE reads. This
  is why `get_metrics` reliably returns "no data for this range" during local
  testing; it's expected, not a bug, and it's why metrics-related fixes in
  this build were verified against the deployed Worker, not locally.
- **Analytics Engine test writes are permanent.** It's append-only — there's
  no delete API — so test data generated during development is still in
  there. Harmless (it just adds noise to a wide enough time window), but
  worth knowing if the numbers ever look odd on a very long lookback.
- **No context trimming for long chat sessions.** Conversation state persists
  across turns via the Agents SDK's durable state, but nothing prunes or
  summarizes it — fine for a demo-length session, would need attention for a
  long-running one.
- **No concurrency guard on a single chat session.** Two messages sent in
  quick succession on the same session before the first finishes could race
  on read-modify-write of the persisted conversation state. Low risk for the
  demo's actual usage pattern (one message, wait for the answer), not fixed.
- **The markdown renderer is a small subset, not a full parser** — headers,
  bold, inline code, and lists, HTML-escaped first. It covers what Claude's
  answers actually produce (verified across every test run in this build),
  not arbitrary markdown.

## What's next, with more time

- **Grafana MCP integration**, swapping the hand-rolled `get_metrics` SQL
  query for a real telemetry vendor via Grafana's official MCP server —
  the natural "next step" flagged above, now that the tool-shaped hole for
  it already exists.
- **Watchdog/operator mode**: reuse the `TrafficGenerator` DO's scheduling
  pattern to run a lightweight version of the investigation loop
  periodically against live metrics vs. baseline, writing an investigation
  record when it finds an anomaly — PLAN.md marked this an optional stretch
  goal from the start, and it stayed unbuilt deliberately rather than adding
  scope this close to done on a build that's already fully verified.
- **Multi-incident scenarios.** Right now there's exactly one seeded ground
  truth (payment-service latency/error regression). Adding a second, distinct
  fault shape — a bad deploy causing errors without latency change, or a
  frontend-level regression — would stress-test whether the pivot-reasoning
  fix generalizes beyond the one scenario it was fixed against, rather than
  just having gotten lucky on this one.
- Smaller items: auth on the `/admin`/`/debug` routes before any wider
  exposure, token-level streaming instead of tool-call-granularity streaming,
  and a write tool behind human confirmation (per the forward-looking
  boundary above) if the read-only constraint were ever lifted.

## Project layout

```
src/
  agent/         investigator.ts (tool loop), tools.ts (5 tools + dispatcher), prompt.ts
  demo-app/      frontend/checkout-service/payment-service, chain.ts, traffic-generator.ts,
                 seed-incident.ts, seed-baselines.ts
  storage/       logs.ts (D1), deploys.ts / fault-flag.ts / baseline.ts (KV), metrics.ts (Analytics Engine)
  index.ts       Worker entry: agent routing, /admin and /debug routes
public/          static chat UI (index.html, chat.js) — no build step, no dependencies
migrations/      D1 schema
```
