# lantern-go

The official Go SDK for [Lantern](https://github.com/dshakes/lantern) — the open-source runtime for production AI agents with VPC deployment, pre-run cost forecasts, policy budgets, and eval-in-CI.

```bash
go get github.com/dshakes/lantern/packages/sdk-go
```

## Quick start

```go
package main

import (
    "context"
    "fmt"
    "log"

    lantern "github.com/dshakes/lantern/packages/sdk-go"
)

func main() {
    // Reads LANTERN_API_URL and LANTERN_API_KEY from the environment by default.
    c := lantern.New()
    ctx := context.Background()

    // 1. Create an agent.
    if _, err := c.CreateAgent(ctx, "triage", "Classifies support emails"); err != nil {
        log.Fatal(err)
    }

    // 2. Hard-cap spend — $25/day, $0.10/run, block on breach.
    perDay, perRun := 25.0, 0.10
    if err := c.UpsertBudget(ctx, "triage", lantern.Budget{
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
    r, err := c.CreateRun(ctx, lantern.RunOptions{
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
c := lantern.New(
    lantern.WithBaseURL("https://my-control-plane.example.com"),
    lantern.WithAPIKey("lnt_..."),
    lantern.WithHTTPClient(myHTTPClient),
)
```

## Errors

Non-2xx responses surface as `*lantern.APIError`:

```go
if apiErr := (&lantern.APIError{}); errors.As(err, &apiErr) {
    if apiErr.Status == http.StatusPaymentRequired {
        // Hard-fail budget blocked the run.
    }
}
```

## Coverage

Agents · Runs · Forecasts · Budgets · Eval suites + runs + baselines. MCP registry, marketplace, and experiments are planned — the TypeScript SDK currently tracks the full surface.

## License

Apache 2.0.
