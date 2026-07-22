# oncall-investigator

An AI agent on Cloudflare Workers that investigates infrastructure incidents —
correlates logs, metrics, and deploys to find root cause. Built against the
"log and trace investigator" direction: not a viewer, an investigator. It
decides what to look at next, and it can be wrong or incomplete about it,
honestly.

**Live:** https://oncall-investigator.charitha-vadamala-99.workers.dev/
**Code:** https://github.com/CharithaVadamala9/oncall-investigator (public)

## What it does, in one pass

The project is self-contained: a hand-rolled 3-service demo app (`frontend` →
`checkout-service` → `payment-service`) is both the thing being monitored and
the test harness. Traffic runs continuously on a schedule. Five distinct,
seedable incidents give known, gradeable ground truth — which service, what
deploy (or deliberately no deploy), what time window, what the numbers looked
like before and after — so every investigation the agent runs can be checked
against a known answer instead of just "looks plausible."

An investigator agent — a hand-rolled tool-calling loop against
`@anthropic-ai/sdk` (Claude Sonnet), *not* a framework — has six read-only
tools: list known services, pull aggregated logs, query latency/error
metrics, check deploy history, compare against known-normal baselines, and
search past resolved investigations. You describe a symptom in the chat UI;
it decides which tools to call and in what order, subject to a hard step
budget, and either finds the root cause or honestly says it couldn't.

Two more pieces sit on top of the core loop: every investigation is
automatically recorded into a small knowledge base the agent can search in
future investigations, and a separate scheduled agent periodically digests
that history into a plain-language summary.

## Try it — under 5 minutes

**1. Seed the baseline** (once; safe to repeat):
```
curl -X POST https://oncall-investigator.charitha-vadamala-99.workers.dev/admin/seed-baselines
curl -X POST https://oncall-investigator.charitha-vadamala-99.workers.dev/admin/start-traffic
```
This starts a background traffic generator (a simulated request every 15s)
and writes the known-normal reference numbers each tool compares against.
Traffic keeps running until you call `/admin/stop-traffic` — do that when
you're done, or it'll run indefinitely.

**2. Trigger one of five seeded incidents** — each is a `POST` to a distinct
route, and each represents a genuinely different failure shape, not five
copies of the same one:

| Route | What it seeds | What a correct answer looks like |
|---|---|---|
| `/admin/seed-incident` | `payment-service` gets ~2000ms slower + ~25% error rate, correlated with a real deploy 5 min earlier | Root cause: `payment-service`, correlated with the `v1.4.2` deploy; `checkout-service`'s `504`s are the symptom |
| `/admin/seed-checkout-incident` | `checkout-service` gets its own ~900ms latency + ~15% error rate — `payment-service` is completely uninvolved | Root cause: `checkout-service` itself, correlated with its own `v3.0.1` deploy; the agent should explicitly check and *rule out* `payment-service` |
| `/admin/seed-auth-incident` | `frontend` starts rejecting ~35% of requests as `401`s, correlated with a deploy — tagged *identically* to the constant background noise, only the rate and deploy differ | Root cause: `frontend`'s own auth deploy, not a downstream failure — the agent has to notice a rate deviation, not just a tag |
| `/admin/seed-outage` | `payment-service` becomes entirely unreachable (no deploy) — `checkout-service` fails fast instead of timing out slow | Root cause: `payment-service` down/unreachable; the agent should describe this as a connection-level failure, distinct from an application error |
| *(no seed needed)* | Ask about a service that doesn't exist, e.g. "is `inventory-service` okay?" | "Inconclusive" — no fabricated root cause |

**3. Open the [chat UI](https://oncall-investigator.charitha-vadamala-99.workers.dev/)**
and describe a symptom, e.g. *"checkout-service is timing out for users right
now, what's going on?"* Watch the tool-call trace stream in, then the final
answer.

**4. Optional — see the knowledge base work.** After a couple of
investigations, `POST /admin/generate-summary` produces a plain-language
digest of recent investigations (`GET /admin/summaries` to see stored ones).
Ask a second, differently-worded question about the same live incident and
watch the trace include a `search_past_incidents` call.

Every `/admin/*` and `/debug/*` route is intentionally unauthenticated (see
[Scope](#scope-whats-excluded-and-why)) — if you're poking around and hit one
by accident, that's expected, not broken.

## Architecture

```
                          ┌─────────────────────────┐
   browser (chat UI) ───▶│  Investigator (DO)       │
   WebSocket             │  hand-rolled tool loop   │───▶ Anthropic API
                          │  vs @anthropic-ai/sdk    │
                          └───────────┬─────────────┘
                                      │ executeTool()
                          ┌───────────▼─────────────┐
                          │  6 read-only tools       │
                          └─┬───────┬───────┬────────┘
                            │       │       │
          D1 (logs, incident_reports, weekly_summaries)
                KV (deploys, faults, baselines)
                Analytics Engine (metrics)
                            ▲       ▲
                            │       │
          ┌─────────────────┴───────┴────┐   ┌────────────────────────┐
          │  TrafficGenerator (DO)       │   │  SummaryAgent (DO)      │
          │  scheduled every 15s         │   │  scheduled every 5 min  │
          │  → frontend → checkout       │   │  reads incident_reports,│
          │    → payment (in-process)    │   │  writes a digest        │
          └──────────────────────────────┘   └────────────────────────┘
```

**Runtime**: Cloudflare Agents SDK (Durable Objects) for state, WebSocket
streaming, and scheduling — but *not* its opinionated tool-calling harness.
**Reasoning**: a hand-written loop directly against `@anthropic-ai/sdk`, not
LangChain/CrewAI/Strands. Hard constraint, not a preference: "how the loop is
driven, how context is managed, what happens when a tool fails" has to be
code that's actually ours to defend, not a framework's black box.

**Three Durable Objects, each earning its place** — not used to show off the
platform, used because each has a genuine reason to need Durable Object state
(remembering something between events, or waking itself up on a timer, which
a plain Worker can't do):
- `Investigator` — one per chat session, remembers conversation history.
- `TrafficGenerator` — reschedules itself every 15s to keep the demo app's
  "production" traffic flowing.
- `SummaryAgent` — reschedules itself every 5 minutes (standing in for
  "weekly" at demo speed, same move as the traffic generator's 15s standing
  in for continuous production traffic) to digest recent investigations.

**The demo app is simulated in-process, not three real Worker-to-Worker
hops.** `frontend`, `checkout-service`, and `payment-service` are plain async
functions called directly in sequence within one Worker. Each hop still
measures real wall-clock latency, writes a real D1 log row, and writes a real
Analytics Engine data point — the data is genuine, just without literal
network round-trips between isolates. Deliberate simplification, chosen over
real service bindings for topology fidelity nobody would actually query for.

**checkout-service's own measured latency includes payment-service's**,
because checkout's handler blocks on the `await` to payment — this is exactly
what makes the original seeded incident work: payment-service getting slow
shows up as checkout-service's *own* latency ballooning, even though
checkout's code never changed. That's the mechanism that forces the agent to
traverse services rather than read one table and stop.

## The six tools

All read-only. No tool does correlation on the agent's behalf — that
intelligence has to live in the model's reasoning, or the build reduces to "a
single fancy prompt with a database attached."

| Tool | Args | Reads from | Notes |
|---|---|---|---|
| `list_services` | — | D1 | `SELECT DISTINCT service` — no separate services table for a static 3-row list |
| `get_metrics` | `service, window_minutes` | Analytics Engine (SQL API) | p50/p95/p99 latency, error rate, request count |
| `get_logs` | `service, since_minutes_ago, until_minutes_ago?, level?, limit?` | D1 | Aggregated counts (uncapped) + a capped, error-prioritized sample (default 20, max 50) — never a raw dump |
| `get_deploys` | `service, since_minutes_ago` | KV | Deploy timeline for that service |
| `get_baseline` | `service` | KV | Known-normal ranges, so the agent can say what's *abnormal*, not just report numbers |
| `search_past_incidents` | `query?, limit?` | D1 | Past resolved investigations, keyword-matched — a runbook, not semantic search (see below) |

Every time-range argument is **relative** (minutes ago / a window in
minutes), not absolute epoch timestamps — see
[Bugs found during testing](#bugs-found-during-testing) for why, and why the
fix removes an entire failure mode rather than just shrinking it.

## Agent loop & guardrails

Guided loop, not a rigid state machine: the system prompt suggests an
investigative order, but the model's own tool selection decides the actual
path per investigation.

- **Step cap**: 8 tool calls max, counted per individual tool execution (a
  single turn can request several in parallel). Hitting it doesn't just cut
  the model off — it makes one final call with `tools` omitted entirely
  (forcing a text-only reply, since this SDK version has no
  `tool_choice: "none"`), so the model produces a coherent "here's what I
  found, investigation incomplete" summary instead of an abrupt stop.
- **Duplicate-call short-circuit**: identical tool + identical arguments
  called twice in one investigation is treated as a stuck-loop signal and
  routed through the same graceful-wrap-up path as the step cap.
- **Structured tool failures**: every tool returns `{error: "..."}` rather
  than throwing, and failed results are flagged `is_error: true` on the
  `tool_result` block so the model reliably recognizes a failed call rather
  than parsing JSON to guess.
- **Context management**: `get_logs` always returns aggregated counts plus a
  capped, error-prioritized sample — never an unbounded dump.
- **Read-only, explicitly**: the system prompt states outright that the agent
  cannot take any action — recommendations only. All 6 tools are read-only by
  design, matching the dominant pattern in the current AI-SRE market (Cleric,
  HolmesGPT). See [What's next](#whats-next-with-more-time) for where a
  supervised write path would go.

## Five seeded scenarios: ground truth & results

Each is independently seedable via the routes in [Try it](#try-it--under-5-minutes).
Together they test five different reasoning skills, not five variations on
one theme — picked deliberately after the first scenario was solid, to find
out whether the agent's behavior was real judgment or pattern-matching one
story.

**1. Payment-service latency regression** (the original scenario). Recognized
a **~48x latency regression** by calling `get_baseline` and comparing —
the tool doesn't compute this, the model does. Matched the exact `trace_id`
between a `checkout-service` failure and the corresponding `payment-service`
log entry to prove a specific traced causal link, not a coincidence of
timing. Landed on the right root cause using 7 of 8 available tool calls.

**2. checkout-service is the actual culprit**, no payment-service
involvement. Tested with the *exact same question* used for scenario 1
("checkout-service is timing out"), specifically to check whether the answer
changes with the evidence or just pattern-matches the question. It does
change: the agent explicitly called `get_metrics`/`get_logs` on
`payment-service`, found it completely clean (independently confirmed via
SQL — zero deviation across the whole test), used that as *positive evidence*
to rule it out, and correctly named checkout-service's own deploy as the
cause.

**3. A real 4xx incident.** `frontend` starts rejecting ~35% of requests as
`401`, tagged *identically* to the always-on 2% background noise (same
status code, same `errorType`, even the same message text) — only the rate
and a correlated deploy differ. Verified with a deliberately vague prompt
("a lot of login failures", never naming the service): the agent computed
the real rate itself from raw log counts, compared it to the 2% baseline, and
correctly avoided the "always pivot downstream" instinct every other scenario
had reinforced — recognizing `frontend` itself as the root cause.

**4. Silent outage.** `payment-service` becomes entirely unreachable, no
deploy involved. `checkout-service` fails *fast* (~15ms, `connection_refused`)
instead of timing out slow, and `payment-service` produces **zero** log rows
for the whole window — verified via SQL with zero exceptions. The agent
correctly reasoned that this is a *connection-level* failure, not an
application bug: *"the requests failing at checkout are never actually
reaching payment-service's app code — they're being refused at the network/
connection level... not rejected by payment-service logic."*

**5. Zero evidence.** Asked about a service that has never existed in the
system. The agent used only 4 tool calls, explicitly said the investigation
was inconclusive rather than fabricating a cause, and — a subtler thing worth
noting — flagged that `list_services` coming back empty was itself suspicious
enough to mention, rather than treating it as a dead end to shrug off.

## The runbook and the weekly digest

**`search_past_incidents`** is backed by a small D1 table
(`incident_reports`), not a vector index — a keyword `LIKE` match, not
semantic search. That's a deliberate scope call: real semantic search needs
an embeddings API call and a vector index, real cost/complexity for a demo
with a handful of records. Writing to it is **not** a tool the model calls —
that would reopen the read-only-tools boundary question. Instead,
`investigator.ts` automatically records `{symptom, summary}` after every
concluded investigation, success or step-cap-truncated alike.

One honest, unresolved trade-off surfaced by testing: the agent naturally
reaches for this tool *last*, as a confirmation step — which means the step
cap can crowd it out entirely (one run explicitly said *"I did not have
budget remaining to search past-incident history"*). Nudging the system
prompt to check it earlier worked mechanically, but exposed a subtler
tension: called early, the agent hasn't gathered enough evidence yet for good
search terms (a vague query like "checkout slow" doesn't match anything);
called late, it searches with much better terms but risks running out of
budget first. Documented as a known trade-off rather than forced into a fix
that might just trade one failure mode for another.

**The weekly digest** (`SummaryAgent`) reuses `TrafficGenerator`'s exact
scheduling pattern for a different job: read recent `incident_reports`, make
one plain summarization call to Claude (no tool loop — condensing already-
recorded text isn't an investigation), store the result. First real output
was a genuinely good demonstration of synthesis, not just concatenation:
given two investigations reported as different symptoms ("login failures"
and "checkout timeouts"), it correctly recognized both traced to the same
root cause and flagged that this was the *second* incident traced to an
apparently never-rolled-back deploy — a systemic pattern a human skimming a
weekly digest would actually want to know.

## Bugs found during testing

These were caught by actually running the agent against live data — locally,
then against the real deployment, then against production traffic — not by
code review or typechecking. Listed because the fix is more informative than
the bug: each is a case where testing surfaced something no amount of reading
the code would have.

- **The Analytics Engine dataset bug** (the deepest one, and the best
  evidence of how this project was actually debugged). A prior version of
  this README described AE test-data contamination as an inherent, permanent
  limitation — that framing was wrong, or at least incomplete. Verifying the
  checkout-service scenario surfaced a case where stale AE data didn't just
  add noise, it **changed a real investigation's conclusion from correct to
  wrong**: `payment-service` was falsely blamed for a checkout-service-only
  incident, with a genuine coincidental payment-service error (its own 0.5%
  baseline chance, firing once by real bad luck) compounding a false
  aggregate signal into an apparently-confident wrong answer. The instinct
  was to rename the AE dataset to escape the pollution — Analytics Engine has
  no delete API, so old residue really is permanent, and a rename really is
  the only escape from it. But the rename alone **didn't fix anything** on
  the first retest, which is what exposed the actual bug:
  `storage/metrics.ts` had `FROM oncall_metrics` hardcoded directly in the
  SQL query text, completely disconnected from the dataset name configured
  in `wrangler.toml`. Writing goes through the Workers binding (which
  correctly picked up the rename); reading is a separate raw HTTP call to
  the Analytics Engine SQL API, and that call had the old name typed
  directly into it — two paths that were supposed to point at the same
  place, silently pointing at different places. Fixed by pulling the name
  into one constant tied explicitly by comment to `wrangler.toml`, and
  confirmed with real before/after numbers: `payment-service` went from a
  fabricated-looking "65x latency regression, 31% error rate" to a correctly
  clean "0% error rate, normal latency" on the identical scenario, and the
  agent's conclusion changed to match.
- **Timestamp drift.** `get_logs`/`get_deploys` originally took absolute
  epoch-ms `since`/`until`, and the system prompt gave "current time" as an
  ISO string for the model to compute against. Across one investigation, the
  model computed two `since` values a full year apart. Fixed by redesigning
  both tools to take `since_minutes_ago`/`until_minutes_ago` (matching
  `get_metrics`'s existing `window_minutes`) — this removes the model's need
  to reason about wall-clock time for *any* tool, rather than just reducing
  the odds of getting it wrong.
- **No pivot.** The agent correctly recognized a `downstream_timeout` as "not
  my bug" but then spent its entire tool budget re-examining the symptomatic
  service instead of investigating the dependency it was blocked on. Fixed
  with an explicit, *generalized* reasoning instruction in the system prompt,
  deliberately not hardcoded to one incident's topology — later validated by
  scenario 2 above, which needed the *opposite* judgment call (don't
  over-pivot when the symptom service really is the cause) and got it right.
- **A ground-truth-corrupting label.** `payment-service`'s own simulated
  random failures were tagged `errorType: "upstream_5xx"` — correct phrasing
  for `checkout-service` (which has a real downstream), wrong for
  `payment-service` (which has none). It caused the model to confidently
  hallucinate a fourth, nonexistent service. Renamed to `internal_error`;
  confirmed the model now correctly states it found no further downstream
  dependency instead of inventing one.
- **Markdown rendering bugs in the chat UI**: headers immediately followed by
  body text on the next line weren't recognized (the parser only checked
  whole paragraph blocks), and numbered/bulleted list items that Claude
  blank-line-separates — which it does often — each rendered as their own
  single-item list. Both found and fixed via real answers in real test runs,
  not synthetic markdown samples.

Smaller fixes: a missing `is_error` flag on failed tool results, a state-
corruption risk if the WebSocket closed mid-investigation, and `max_tokens`
too low (1024), confirmed by an actual truncated answer and raised to 2048.

## Scope: what's excluded, and why

- **No Grafana/Prometheus integration.** The Grafana MCP server and Grafana
  Cloud's free tier both exist and would work — disproportionate setup time
  next to this build's scope. Real next step, not a dismissal.
- **No OpenTelemetry Demo app.** Its fault-injection pattern (a KV/flagd-style
  flag) is genuinely good and was borrowed deliberately — its Docker/
  Kubernetes deployment shape doesn't fit an edge runtime.
- **No cloud dependency mapper or full distributed-trace analyst.** Different,
  equally hard problems from log/metric/deploy correlation. Better to do one
  investigation style well than three shallowly.
- **No LangChain/CrewAI/Strands or any agent-orchestration framework.** Hard
  constraint — the loop has to be code that's actually ours to explain and
  defend line-by-line.
- **No write/action tools.** Read-only end to end — see
  [What's next](#whats-next-with-more-time) for the supervised version of
  this that was deliberately not built.
- **No auth, rate limiting, or billing controls.** Concretely, the
  `/admin/*` and `/debug/*` routes are unauthenticated. Fine for a take-home
  reviewed by a known audience; a real gap the moment this were exposed more
  broadly — noted, not fixed, since it's explicitly out of scope.
- **Multi-agent routing was considered and deliberately not built.** The
  chicken-and-egg problem (routing to a specialized agent requires already
  knowing what's wrong, which requires the tool calls you were trying to
  save) doesn't have a clean answer at this project's scale, and the one
  scenario that would genuinely justify it — two services independently
  faulting at once, needing parallel investigation — was never built either.
  Would revisit if that scenario existed.
- **Multi-incident scenario coverage is intentionally partial**, not
  exhaustive. Five scenarios were picked to each test a different reasoning
  skill (pivot correctly, don't over-pivot, distinguish real signal from
  identically-tagged noise, reason from absence of data, admit zero
  evidence) rather than to maximize count. A larger brainstormed list exists;
  most of it stayed unbuilt on purpose — see What's next.

## Known limitations

- **Analytics Engine writes are permanent** — no delete API, so the dataset
  keeps every test data point ever written under a given name forever. The
  fix for the bug above was a genuine bug fix, but the *underlying* fact
  that old residue can't be cleared is real and permanent; a dataset rename
  is the only way to escape truly old data if this ever gets noisy again.
- **No context trimming for long chat sessions.** Conversation state persists
  via the Agents SDK's durable state, but nothing prunes or summarizes it —
  fine for a demo-length session, would need attention for a long-running one.
- **No concurrency guard on a single chat session.** Two messages sent in
  quick succession on the same session before the first finishes could race
  on read-modify-write of persisted conversation state. Low risk for the
  demo's expected usage pattern (one message, wait for the answer), not
  fixed — noted here explicitly since it's exactly the kind of thing a
  reviewer trying to break the agent could plausibly hit.
- **The markdown renderer is a small subset, not a full parser** — headers,
  bold, inline code, and lists, HTML-escaped first. Covers what Claude's
  answers actually produce, not arbitrary markdown.
- **`search_past_incidents` timing trade-off** — see
  [The runbook and the weekly digest](#the-runbook-and-the-weekly-digest)
  above. Open question, not a bug.

## What's next, with more time

- **Trigger investigations from outside the chat, not just from a human
  typing.** A webhook route that accepts an alert — a Sentry error, a
  PagerDuty page, a GitHub issue, a Slack message — extracts its description
  as the investigation's symptom, runs the *exact same* tool loop headlessly,
  and posts the resulting summary back to the source instead of a chat
  window. This reuses essentially everything that already exists; the only
  new part is who sends the first message. It's also the same underlying
  idea as the watchdog/operator pattern below, just externally triggered
  (an alert arrives) instead of internally triggered (metrics drift from
  baseline) — worth building as one mechanism with two trigger sources
  rather than two separate features.
- **Watchdog/operator mode**: reuse `TrafficGenerator`/`SummaryAgent`'s
  scheduling pattern to run a lightweight version of the investigation loop
  periodically against live metrics vs. baseline, opening an investigation
  on its own when something drifts.
- **A supervised write path**, in two forms, both keeping a human in the
  loop rather than letting the agent act unilaterally:
  - *Remediation actions*: instead of only describing a fix in prose ("roll
    back v1.4.2"), draft the actual mechanism — a PR, a rollback command —
    and require explicit human approval before anything executes. Still
    read-only in effect; the agent proposes, a human triggers.
  - *Knowledge-base writes*: right now every investigation is recorded
    automatically, no review step. That's a real risk, not a hypothetical
    one — the Analytics Engine bug above caused a genuinely wrong
    conclusion during testing, and if the runbook had been live and that
    investigation had been searched by a later one, a confidently wrong
    resolution would have propagated forward as false precedent. Gating
    knowledge-base writes behind human approval (or at minimum, a "did this
    actually get resolved" follow-up) directly prevents the exact failure
    mode this project already produced once.
- **Grafana MCP integration**, swapping the hand-rolled `get_metrics` SQL
  query for a real telemetry vendor via Grafana's official MCP server.
- **The remaining brainstormed scenarios** that didn't make the cut: an
  error spike with *no* latency change (tests whether the agent actually
  reads logs instead of leaning on metrics), a gradual creep instead of a
  step-change (tests trend-reading), two independent faults overlapping
  (the one scenario that would genuinely justify revisiting multi-agent
  routing), and a legitimate business-logic pattern that isn't a bug at all
  (tests whether the agent can conclude "not an engineering problem").
- Smaller items: auth on `/admin`/`/debug` before any wider exposure,
  token-level streaming instead of tool-call-granularity streaming.

## Project layout

```
src/
  agent/         investigator.ts (tool loop), tools.ts (6 tools + dispatcher),
                 prompt.ts, summary-agent.ts (weekly digest DO)
  demo-app/      frontend/checkout-service/payment-service, chain.ts, traffic-generator.ts,
                 seed-incident.ts, seed-checkout-incident.ts, seed-auth-incident.ts,
                 seed-outage.ts, seed-baselines.ts
  storage/       logs.ts (D1), deploys.ts / fault-flag.ts / baseline.ts (KV),
                 metrics.ts (Analytics Engine), incidents.ts / summaries.ts (D1)
  index.ts       Worker entry: agent routing, /admin and /debug routes
public/          static chat UI (index.html, chat.js) — no build step, no dependencies
migrations/      D1 schema (logs, incident_reports, weekly_summaries)
```
