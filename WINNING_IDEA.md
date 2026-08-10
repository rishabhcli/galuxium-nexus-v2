# Galuxium Nexus V2: Winning Idea Dossier

> **Status:** Idea selected; no product name assigned; no implementation started.
> **Submission deadline:** August 31, 2026 at 4:30 AM PT.
> **Ground truth:** [HACKATHON.md](./HACKATHON.md) remains authoritative for rules, form fields, eligibility, and links.

## Final decision

A concurrency-safe, per-tenant hard budget cap for AI inference spend, backed by reservations, settlement, fencing tokens, and an auditable ledger.

## Why this document exists

This is the recovered and finalized output of the Claude Opus 5 Max brainstorming session, including its ruthless elimination, rubric scoring, adversarial review, committed scope, technical architecture, early kill test, build order, demo plan, and honest failure modes. Descriptive phrases below are concept labels only, not a project name.

## Pass 1 — Kill

1. budget-reservation-two-phase — SURVIVES. Hard part is a concurrency invariant, not an API call; demo needs zero setup; monetization is native.

2. migration-blast-radius-gate — KILLED (already exists + rubric miss). Open-source lock analyzers already execute migrations and inspect held locks; and a schema panel scores near zero on UI/UX (15%) and reads as a DBA utility, not a SaaS, on Market Fit (20%).

3. tenant-isolation-adversary — KILLED (out of scope, with fake-difficulty on the reduced version). The honest version requires you to also build a real multi-tenant SaaS for it to interrogate — two products in 21 days — and the version that fits is a library of query templates, which is a library import wearing a lab coat.

4. judge-traffic-shadow-diff — KILLED (out of scope / uncontrolled input). The winning moment is contingent on organic traffic arriving before you record it, which you do not control, and the write-interception layer is a second product.

5. bitemporal-metering-restatement — SURVIVES, barely. The engineering is real; I'm advancing it so Pass 2 has something to test #1 against, not because I think it wins.

6. denial-explainer-leak-safe — KILLED (undemoable). The entire value is why the redacted denial matters, and that requires a paragraph of setup — your own Step 5 disqualifies it.

7. fidelity-ladder-slo — KILLED (out of scope, in the specific sense that it attacks your own submission). Requirement 1 says the link must be "live, stable, and fully accessible"; you'd be publishing a button that invites judges to saturate your free-tier deployment, at real provider cost, possibly while another judge is scoring you.

8. nondeterminism-record-replay — KILLED (out of scope). Byte-identical streaming replay plus the buggy application it debugs plus SDK adoption friction is not a solo 21-day build, and I said so when I wrote it.

9. unoverridable-status — KILLED (already exists + it trades a submission requirement for a demo moment). Synthetic browser checks driving a status page is a shipped commercial category, and the great moment — a judge kills your prod DB — risks the one artifact you cannot afford to break during judging.

10. deletion-proof-taint — SURVIVES. Bullseye on the 20% governance criterion, legible pain, designable surface.

11. calibrated-queue-eta — KILLED (undemoable). The payoff is a scatter plot; against a split screen where money stops burning, a chart loses, and Keynote is a scored criterion.

12. exactly-once-with-adversary — KILLED (already exists). Webhook delivery infrastructure with dedup and replay is a category a judge may personally pay for, and the built-in adversary is a feature of a clone, not a different product.

Nine dead. Three advance.

## Pass 2 — Score the survivors

#1 budget-reservation-two-phase

Technical Architecture & Scalability — 9. Concurrency, crash recovery, idempotent settlement and multi-tenancy are all load-bearing, and the hot-row throughput ceiling is a number you can measure and state.
Enterprise Governance & Compliance — 8. Provider keys vaulted, per-customer scoped keys, full audit ledger, hard spend policy as AI risk control; docked because it isn't security-first by nature.
Product Innovation & Market Fit — 6. The pain is current and universal, but the category is crowded and a judge who has used an LLM gateway will say so. This is the weak one.
Monetization & Fiscal Design — 10. The product is a metering and prepaid-credit primitive; nothing else on this list can match that on a criterion worth 15%.
UI/UX & Visual Refinement — 8. Live burn-down plus ledger is designable to a premium standard, but it is fundamentally a dashboard.
Keynote Pitch & Demo Completeness — 9. Two numbers, no setup, and a judge can reproduce it at your URL.
Total 50/60. Rubric-weighted 8.2/10.

#10 deletion-proof-taint

Technical Architecture & Scalability — 7. Taint tracing and resumable idempotent deletion are real work, but there is no load story and no concurrency story on a criterion that names scaling explicitly.
Enterprise Governance & Compliance — 10. Best fit in the entire set.
Product Innovation & Market Fit — 7. Erasure is legible to a non-engineer; funded incumbents own the category.
Monetization & Fiscal Design — 5. "Compliance subscription" is asserted on a slide, not demonstrated by the system. Weak, and I am not averaging it away.
UI/UX & Visual Refinement — 8. The findings report and the residuals view are genuinely designable.
Keynote Pitch & Demo Completeness — 7. Strong shape, but the payoff is nine copies inside a fixture you authored.
Total 44/60. Rubric-weighted 7.45/10.

#5 bitemporal-metering-restatement

Technical Architecture & Scalability — 9. Bitemporality, watermarks, sealed periods, exactly-once aggregation.
Enterprise Governance & Compliance — 7. Auditability of financial records, but no security or privacy surface at all.
Product Innovation & Market Fit — 4. This is a usage-based billing platform; three well-known companies do it, one of them open source. A judge sees a clone.
Monetization & Fiscal Design — 10. Native.
UI/UX & Visual Refinement — 6. Invoices can be clean; they cannot be striking.
Keynote Pitch & Demo Completeness — 4. "The number reconciles" is a weak moment and it is the only moment. Fatal.
Total 40/60. Rubric-weighted 6.8/10.

Top two: #1 and #10.

## Pass 3 — Adversarial review

### Against #1, from a judge on submission 200:

"This is LiteLLM with a nicer dashboard. LiteLLM has budgets. Portkey has budgets. Helicone tracks cost. You have built a reverse proxy in front of someone else's API and the hardest artifact in your repo is a database transaction. I have seen four gateways today. Next."

Answer, and I concede part of it: the category is genuinely crowded and the judge is right that a proxy is a known shape. What survives is narrower than you'd like — the existing tools check a cached counter before a call whose cost is unknowable until after it completes, so they overshoot under concurrency by design, and none of them survive a worker crash mid-stream without leaking reservation. That difference is real and it is arithmetic, not opinion. But it is narrow, and a judge who does not run the comparison takes your word for it. The mitigation is that the comparison must be runnable by them at your live URL, not asserted in your README. I concede this caps your Innovation score around 6 and there is no way to raise it — you win this on the other five criteria or not at all.

### Against #10, from the same judge:

"You wrote an app, planted nine copies of an email in it, then wrote a script that finds nine copies of an email. Data discovery and DSR automation is a category with multiple funded vendors and an open-source implementation. The hard part you named is regex tolerance. Nothing here is verifiable to me."

Answer: this lands harder and I mostly concede it. The decisive asymmetry against #1 is verifiability. In #1, the judge supplies the load, the cap is a number they chose, and the result is checkable against provider pricing they can look up — you cannot fake it. In #10, the proof is entirely internal to a fixture you authored; a skeptical judge cannot distinguish real discovery from a planted demo, and on a criterion set that says "must reflect structural integrity," an unfalsifiable proof is worth much less than a falsifiable one. Add the 5/10 on monetization and it doesn't close a 6-point gap.

## Pass 4 — The pick

Idea #1. Committing.

Note what I'm doing: I'm picking the highest-typicality survivor (0.18) out of a set I built by tail-sampling. That is deliberate. Novelty was the generator's job; the picker's job is winning. Typicality of category is not typicality of claim, and the claim here is the only one on the list a stranger can verify in ninety seconds without trusting you.

## The one-line version

"It's a hard dollar cap on AI API spend, per customer. You set a ceiling, and going over it is not possible — not under a burst, not under a crash."

## The specific problem

Anyone shipping an AI feature to users they don't control, or reselling model access. Providers bill after the fact and their limits are per-organization, not per-customer, so a retry storm, an agent loop, or one leaked key is unbounded liability on your card. Every existing control is a dashboard: it reads a counter, compares, and calls — but the cost of the call isn't known until it finishes, so N concurrent requests all pass the same check and you find out you're 6x over when the invoice arrives. Today teams eat the overage, poll usage endpoints on a lag, or simply don't ship the feature to untrusted users. The last one is the real cost.

## Scope boundary

The single thing it does: enforce a per-tenant dollar ceiling on model spend as a hard invariant, with an auditable ledger behind it.

Explicitly not building:

Prompt or semantic caching. Every gateway has it, it's a week, and it corrupts your cost accounting right where your entire claim lives.
Model routing, fallback, or provider load balancing. Different product. Doubles the surface. Cut.
Prompt logging, tracing, evals, analytics. Cut — and then convert the cut into a governance claim: we never store prompt or completion bodies, only token counts and cost. That is a privacy property, and it costs you nothing because you weren't building it.

## Architecture

Edge: OpenAI-compatible /v1/chat/completions, streaming passthrough.
Auth: two key classes. Admin keys manage budgets and mint keys. Scoped keys can only spend, are bound to one budget, and are the thing you hand an untrusted party. Hashed at rest, prefix-indexed for lookup.
Admission: reservation service computes a worst-case cost, attempts an atomic conditional debit, and returns a structured 402 before any upstream call if it fails.
Upstream: provider call with stream_options: {include_usage: true} injected; a passthrough meter counts emitted tokens as the fallback path.
Settlement: on completion, abort, or error, reconcile actual against reserved and release the difference. Idempotent, keyed on request id.
Ledger: append-only entries in Postgres. Balance maintained in the same transaction as the entry, never in a separate write.
Reaper: reservations carry expiry and a fencing token; a background job releases orphans.
Isolation: RLS on tenant_id, per-request role.
Surfaces: dashboard (live burn-down, ledger, keys, invariant readout) and a public comparison harness.

The hard part lives entirely in the reservation/settlement pair and the reaper. Everything else is plumbing you can write tired.

## The hard technical core

The bound. You cannot reserve the true cost, so you reserve prompt_tokens × input_price + max_tokens × output_price. The trap: clients routinely omit max_tokens, which makes the bound the model's full context window, which means one request reserves the entire budget and the product is useless. You need a per-budget max_tokens ceiling, injected when the client omits it. This is a real design decision with a user-visible consequence and you should be able to defend it on camera.

The debit. One statement, no read-then-write:
UPDATE budgets SET reserved = reserved + $1 WHERE id = $2 AND balance - reserved - $1 >= 0 RETURNING *
Zero rows affected means reject. This serializes on a single row — that is your throughput ceiling, you should measure it, and you should say the number out loud rather than let a judge find it. If it bites, shard the budget into N sub-rows with periodic rebalancing; optional, and a good thing to have in the README whether or not you build it.

Streaming settlement. Usage only arrives in the terminal SSE chunk if you asked for it, so you inject the flag and decide whether to strip it back out. The case everyone gets wrong: the client disconnects mid-stream and no terminal chunk ever arrives. You must settle against tokens you actually forwarded, counted locally.

Crash safety. Reservation rows carry expires_at and a monotonic fence. The reaper releases expired reservations. If the original worker resurrects and tries to settle afterward, its fence is stale, the settlement is rejected, and a compensating entry is written instead. Without fencing you double-release and quietly leak money — which is the exact failure your product exists to prevent, so getting it wrong is unrecoverable if a judge finds it.

Exactly-once settlement. Unique constraint on request id; a retried settlement is a no-op returning the prior result.

The invariant. A checker asserting, per budget: balance = credits − Σ settled − Σ open reservations. Run it in CI, run it live, put it on the dashboard. This is your proof artifact and it is what separates you from a dashboard.

## Build order

### Day 1: the overshoot experiment below. Before code.
### Day 1–2: end-to-end skeleton. One provider, one non-streaming request, deduct after the fact, deployed to a public URL on a real domain. A working end-to-end path exists on day 2. Everything after this is improvement, never completion.
### Day 3–4: tenants, budgets, keys, auth, Postgres with RLS.
### Day 5–7: reservation, conditional debit, settlement, idempotency, invariant checker. Three days, because this is the product.
Day 8–9: streaming, usage injection, abort handling, emitted-token fallback.
Day 10–11: reaper, fencing, chaos script that kills a worker mid-stream and asserts the balance heals. Write it now — it's also your demo.
Day 12–13: naive-comparator toggle and the concurrent load harness, both callable from the public page. Build the demo before the UI.
Day 14–16: dashboard. Three days, not one — this is 15% and it's where infra projects bleed out.
Day 17: per-key rate limiting, request id on every response, structured logs, health and metrics endpoints, README, ADRs.
Day 18: executive briefing, monetization writeup, screenshots.
Day 19: video. Script, shoot, cut.
Day 20: buffer, because the video will go wrong.
Day 21: submit. The deadline is 4:30 AM PT on Aug 31, which in practice means the evening of Aug 30. Do not plan to be awake for it.

## Riskiest assumption

That the worst-case bound is tight enough to be usable. If a typical request reserves 20x its actual cost, a $10 budget behaves like a $0.50 budget, legitimate requests get rejected, and you have built a very rigorous toy.

The 48-hour test, and it is a spreadsheet, not code: take 200 representative requests, compute reserved-versus-actual under your default max_tokens policy, plot the ratio. If p50 overshoot exceeds ~5x, redesign before you write the ledger. Pre-planned fixes in order of preference: a per-budget max_tokens ceiling; an adaptive bound from a rolling estimate of that tenant's output lengths with a hard fallback; a bounded overdraft epsilon settled on completion. Do this on day one — it is the only thing that can invalidate the whole build, and it costs you an afternoon.

## The demo — 2:45

0:00–0:12 — No logo, no title card. A bill, and a cap setting that didn't hold. "This cap was $50."
0:12–0:25 — The claim in one sentence.
0:25–1:00 — Split screen. Both sides: $0.50 budget, 200 concurrent requests, same model, same provider. Left is labeled "check-then-call — the common pattern" and climbs to $3.11. Right climbs, bends, and stops at $0.4997 with request 143 returning 402. Freeze on both numbers. Winning moment: 0:52.
1:00–1:25 — Crash test. Kill the worker mid-stream. Reserved-but-unsettled appears. Reaper fires around 1:18, orphan releases, invariant readout returns to OK on screen.
1:25–1:50 — Product surface. Create a customer, fund $5, mint a scoped key, watch the burn-down. Ledger with per-request attribution. Say the privacy line out loud: no prompt bodies stored.
1:50–2:15 — Second tenant. The cross-tenant read is denied. One line of policy on screen.
2:15–2:35 — Monetization: prepaid credits as a primitive, and the platform's own pricing running on its own meter.
2:35–2:45 — Live URL. "Run the comparison yourself, here."

## Rubric map

Technical Architecture & Scalability (20%) — two-phase reservation ledger, fencing tokens, idempotent settlement, RLS multi-tenancy, and a stated measured throughput ceiling on the hot row.
Enterprise Governance & Compliance (20%) — provider credentials never leave the vault, scoped per-customer keys, zero prompt retention, full audit ledger, hard spend policy as concrete AI risk mitigation rather than a paragraph about alignment.
Product Innovation & Market Fit (20%) — the friction is unbounded liability when shipping AI to users you don't control; the transformative move is converting a dashboard into an invariant.
Monetization & Fiscal Design (15%) — metered prepaid credits, which is the criterion's own "transactional loop," demonstrated by the platform billing itself on its own meter.
UI/UX & Visual Refinement (15%) — live burn-down, onboarding that ends in a working scoped key inside 60 seconds, and a 402 that reads as a sentence rather than a status code.
Keynote Pitch & Demo Completeness (10%) — the 0:52 split screen, reproducible by the judge at the live URL.

## What would make this lose anyway

A judge who has used an existing gateway scores Innovation at 4, and 20% is not recoverable. This is the largest single risk and the "invariant, not dashboard" framing is your only defense.
Your comparator is a strawman you wrote. Implement it as the literal common pattern and label it as such — a hostile judge still discounts it, and they are not entirely wrong to.
The overshoot ratio makes the cap unusable and you discover it on day 12 instead of day 1.
Provider spend during a public load harness. Cap yourself with your own product, and say that on camera — it's a good line and it's true.
The sponsor is an AI infrastructure company and the top prize is credits on their stack. If judging quietly favors submissions built on it, you use none of it. Routing through it is one config line if you decide that matters.
The rubric gets scored by someone who doesn't read code, in which case a prettier project with a worse spine beats you on vibes. Nothing to be done about that except spending the full three days on the dashboard.
