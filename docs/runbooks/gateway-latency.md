# Runbook — gateway / model-router down or slow

> **Audience:** on-call operators.
> **Fires from:** `GatewayDown` (critical), `ModelRouterDown` (critical),
> `GatewayP99LatencyHigh` / `ModelRouterP99LatencyHigh` (warning, **TODO**).
> **Dashboards:** Lantern — Platform Overview.

These two Rust services sit on the hot path:

- **gateway** (`:8443`, TLS) — API/SDK ingress and end-to-end token streaming.
- **model-router** (`:50053`) — maps capability names (`"auto"`,
  `"reasoning-large"`) to concrete vendor models; **every** LLM call goes through
  it (caching, routing, metering). If it's down, all completions and agent LLM
  steps fail.

---

## What fired it

- **`GatewayDown` / `ModelRouterDown`** — the `up` probe for the service is 0 for
  2m. Process unreachable.
- **`GatewayP99LatencyHigh` / `ModelRouterP99LatencyHigh`** — **TODO, not active.**
  These depend on Prometheus histograms
  (`lantern_gateway_request_duration_seconds_bucket`,
  `lantern_model_router_request_duration_seconds_bucket`) that are **not emitted
  yet**. Today these Rust services export **OTel traces only**
  (`services/{gateway,model-router}/src/otel.rs`) — no scrapeable histogram. The
  rules are parked, commented, in `infra/monitoring/prometheus/alerts.yml`.

> **Until the histograms ship, p99 latency lives in the tracing backend**
> (Tempo/Jaeger), not Prometheus. To enable the latency alerts: add a request
> -duration histogram on each service's request path and expose it on a
> `/metrics` endpoint, confirm the series, then uncomment.

---

## Triage

```bash
# Pods + recent logs for each.
kubectl -n <ns> get pods -l app.kubernetes.io/name=gateway
kubectl -n <ns> get pods -l app.kubernetes.io/name=model-router
kubectl -n <ns> logs deploy/<gateway> --tail=200
kubectl -n <ns> logs deploy/<model-router> --tail=200 | grep -i 'error\|timeout\|upstream\|429\|5..'

# Liveness from inside the cluster.
kubectl -n <ns> exec deploy/<gateway> -- sh -c 'nc -z localhost 8443 && echo ok'
```

**Latency (today, via traces):** open the tracing backend, filter spans by
service `model-router` / `gateway`, sort by duration. The model-router span tree
shows whether the time is in Lantern routing or in the **upstream vendor** call
(OpenAI/Anthropic). A vendor slowdown or rate-limit (HTTP 429 in the logs) is the
most common "model-router is slow" cause and is not a Lantern bug.

---

## Remediation

1. **Service down / CrashLoop** — triage the pod (`describe`, `--previous` logs,
   resources). If it began right after a deploy, roll back:
   `kubectl -n <ns> rollout undo deploy/<service>`.
2. **model-router slow due to upstream vendor** (429s / high upstream span time)
   → not fixable in Lantern directly. Confirm provider status, check whether a
   single provider is the bottleneck, and lean on the router's failover/routing
   to shift load. Raise provider quota if it's a sustained limit.
3. **gateway slow** → check for backpressure / a stuck stream; streaming is
   end-to-end with no buffering point, so a slow consumer can show as gateway
   latency. Correlate with the run that's streaming.
4. **OOM/resource starvation** → bump `resources.limits` for the service in Helm
   values and roll.

Confirm recovery: `up` back to 1; completions succeed end-to-end (a test run
streams tokens); trace p99 back to baseline.

---

## Escalate

- A vendor outage/limit is the root cause → **platform on-call** to manage
  provider routing/quota; this is upstream, not a Lantern fix.
- Hot-path regression after a Rust deploy that rollback doesn't fix → the owning
  team + **platform on-call**.
