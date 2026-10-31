# PAL Runtime Go SDK

The official Go SDK for [PAL Runtime](https://github.com/dshakes/pal) — the open-source runtime for production AI agents with VPC deployment, pre-run cost forecasts, policy budgets, and eval-in-CI.

```bash
go get github.com/dshakes/pal/packages/sdk-go
```

## Quick start

```go
package main

import (
    "context"
    "fmt"
    "log"

    pal "github.com/dshakes/pal/packages/sdk-go"
)

func main() {
    // Reads PAL_API_URL and PAL_API_KEY from the environment by default.
    c := pal.New()
    ctx := context.Background()

    // 1. Create an agent.
    if _, err := c.CreateAgent(ctx, "triage", "Classifies support emails"); err != nil {
        log.Fatal(err)
    }

    // 2. Hard-cap spend — $25/day, $0.10/run, block on breach.
    perDay, perRun := 25.0, 0.10
    if err := c.UpsertBudget(ctx, "triage", pal.Budget{
        MaxCostUsdPerDay: &perDay,
        MaxCostUsdPerRun: &perRun,
        HardFail:         true,
    }); err != nil {
        log.Fatal(err)
    }

    // 3. Forecast before dispatching.
    f, err := c.ForecastRun(ctx, "triage", "invoice is wrong")
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("estimate: $%.4f (%.0f%% confident, block=%v)\n",
        f.EstimatedCostUsd, f.Confidence*100, f.WouldExceedBudget)

    // 4. Run.
    r, err := c.CreateRun(ctx, pal.RunOptions{
        AgentName: "triage",
        Input:     map[string]string{"email": "..."},
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println("run:", r.ID, "status:", r.Status)
}
```

## Options

```go
c := pal.New(
    pal.WithBaseURL("https://my-control-plane.example.com"),
    pal.WithAPIKey("lnt_..."),
    pal.WithHTTPClient(myHTTPClient),
)
```

## Errors

Non-2xx responses surface as `*pal.APIError`:

```go
if apiErr := (&pal.APIError{}); errors.As(err, &apiErr) {
    if apiErr.Status == http.StatusPaymentRequired {
        // Hard-fail budget blocked the run.
    }
}
```

## Coverage

Agents · Runs · Forecasts · Sessions · Connectors · Budgets · Eval suites + runs + baselines · A/B experiments · Marketplace · MCP registry · Verifiable receipts · Run feedback · Rehearsals.

## License

Apache 2.0.
