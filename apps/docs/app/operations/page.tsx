import Link from "next/link";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/operations");

const RUNBOOKS = "https://github.com/dshakes/lantern/tree/master/docs/runbooks";

export default function OperationsPage() {
  return (
    <>
      <h1>Operations</h1>
      <p>
        What you do after <code>helm install</code>: scrape the metrics, wire the alerts, keep backups you have actually restored,
        and upgrade without losing data. The install itself is on <Link href="/deployment#helm">Deployment</Link>; every setting
        named here is in <Link href="/env-vars">Environment variables</Link>.
      </p>

      <h2 id="install">Install pointers</h2>
      <p>
        One chart, <code>infra/helm/lantern</code>, with <code>values-dev.yaml</code>, <code>values-staging.yaml</code> and{" "}
        <code>values-prod.yaml</code>. The chart defaults <code>LANTERN_ENV=production</code>, so the production startup guards are on.
      </p>
      <pre><code>{`helm install lantern ./infra/helm/lantern \\
  --namespace lantern --create-namespace \\
  --values infra/helm/lantern/values-prod.yaml`}</code></pre>
      <ul>
        <li>
          Supply the secrets the guards require (<code>secrets.jwtSecret</code>, <code>credentialKey</code>,{" "}
          <code>receiptSecret</code>, <code>grpcServiceToken</code>, and the rest listed under{" "}
          <Link href="/deployment#helm">Production settings</Link>). The{" "}
          <Link href="/env-vars#prod-checklist">production checklist</Link> shows which process needs which.
        </li>
        <li>
          <code>values-prod.yaml</code> turns the in-cluster Postgres and object store off. Set{" "}
          <code>externalDatabase.host</code> and <code>externalS3.endpoint</code> or <code>helm template</code> fails on purpose.
        </li>
        <li>
          Turn on <code>networkPolicy.enabled=true</code> (needs a CNI that enforces policy, such as Calico or Cilium) and list
          your Prometheus namespace under <code>networkPolicy.metricsFrom</code>; the default allows the{" "}
          <code>monitoring</code> namespace.
        </li>
      </ul>

      <h2 id="metrics">Metrics</h2>
      <p>
        Two Prometheus endpoints exist. The control plane serves <code>/metrics</code> on its own listener, port{" "}
        <code>9464</code> (<code>LANTERN_METRICS_ADDR</code>), not on the public <code>:8080</code> API, because the endpoint is
        unauthenticated and its labels carry agent names: scrape it from Prometheus, never through ingress. The runtime
        scheduler serves <code>:8085/metrics</code>. The Helm chart annotates the control-plane pod with{" "}
        <code>prometheus.io/port: 9464</code> and the NetworkPolicy allows both scrape paths from{" "}
        <code>networkPolicy.metricsFrom</code>.
      </p>
      <pre><code>{`kubectl -n lantern port-forward deploy/lantern-control-plane 9464:9464 &
curl -s localhost:9464/metrics | grep -E '^(lantern_|http_server_request_duration_seconds_count)' | head`}</code></pre>
      <p>
        You should see <code>lantern_run_total</code> (label <code>lantern_status</code>), <code>lantern_run_budget_blocks_total</code>{" "}
        and the <code>http_server_request_duration_seconds</code> series that the 5xx alert uses. Step-level
        series (duration, retries, replay skips, budget-check errors, onboarding steps) appear as the matching events happen.
        Deployment and CronJob names are prefixed with your release name; adjust them.
      </p>
      <p>
        Gateway and model-router emit traces only, no Prometheus histograms yet, so their latency SLOs live in your tracing backend
        (see <Link href="/runtime/observability#data-path">Observability</Link>).
      </p>

      <h2 id="alerts">Alert groups</h2>
      <p>
        Rules are in <code>infra/monitoring/prometheus/alerts.yml</code>; two Grafana dashboards (<code>platform-overview.json</code>,{" "}
        <code>data-plane-runtime.json</code>) are in <code>infra/monitoring/grafana/</code>. Every alert has a{" "}
        <code>runbook:</code> annotation pointing at a file in <a href={RUNBOOKS} target="_blank" rel="noopener noreferrer">docs/runbooks</a>.
      </p>
      <table>
        <thead><tr><th>Group</th><th>Alerts</th><th>Needs</th></tr></thead>
        <tbody>
          <tr><td><code>lantern-scheduler</code></td><td>SchedulerDown, SchedulerNoLeader, SchedulerScheduleErrorRateHigh, SchedulerQuotaRejectionSurge, SchedulerNoRegisteredNodes</td><td>scrape job <code>lantern-runtime-scheduler</code> on <code>:8085</code></td></tr>
          <tr><td><code>lantern-liveness</code></td><td>ControlPlaneDown, ControlPlaneNotReady, GatewayDown, ModelRouterDown</td><td>jobs <code>lantern-control-plane</code>, <code>lantern-gateway</code>, <code>lantern-model-router</code>, and a blackbox probe <code>lantern-control-plane-readyz</code> on <code>/readyz</code></td></tr>
          <tr><td><code>lantern-postgres</code></td><td>PostgresExporterDown, PostgresConnectionSaturation, DataPlaneHeartbeatStale, CronScheduleOverdue</td><td><code>postgres_exporter</code> with <code>postgres-exporter-queries.yaml</code></td></tr>
          <tr><td><code>lantern-instrumented-slos</code></td><td>ControlPlane5xxRateHigh (&gt;5% for 5 m), RunFailureRateHigh (&gt;20% for 10 m), BudgetDenied402Surge</td><td>control-plane job scraping <code>:9464</code></td></tr>
        </tbody>
      </table>
      <p>
        The job names must match the ones in the rules. Gateway and model-router p99 rules are parked, commented out, in a
        &quot;needs instrumentation&quot; group: do not enable a rule before its series exists, because a rule over a missing series is
        silently always green. <code>RunFailureRateHigh</code> counts inline-executor runs only; microVM-tier runs are not counted yet.
      </p>

      <h2 id="backups">Backups and the restore drill</h2>
      <p>
        <strong>Production: use managed Postgres</strong> (RDS, Cloud SQL, Azure Database) with automated backups and point-in-time
        recovery, and set <code>postgresql.enabled=false</code> with <code>externalDatabase.*</code>. The in-cluster Postgres is a
        single pod on a PVC for dev and evaluation. If you self-host it, enable the logical backup as a floor:
      </p>
      <pre><code>{`# values: backup.enabled=true  (schedule "0 2 * * *", s3Bucket lantern-backups, retentionDays 14)
kubectl create job --from=cronjob/lantern-postgres-backup backup-manual-1 -n lantern   # dump on demand
aws s3 ls s3://lantern-backups/postgres/                                              # newest object should be under 24 h old`}</code></pre>
      <p>
        The CronJob (<code>&lt;release&gt;-postgres-backup</code>) runs <code>pg_dump</code>, gzips it to{" "}
        <code>s3://&lt;bucket&gt;/postgres/lantern-&lt;ts&gt;.sql.gz</code>, and prunes dumps older than <code>retentionDays</code>. A failed or empty
        dump fails the pod before anything is uploaded or pruned. With <code>backup.useChartMinio=true</code> (the default) it uploads
        to the release&apos;s own object store; for real durability point it at external S3 with <code>backup.existingSecret</code>.
      </p>
      <h3 id="drill">The restore drill</h3>
      <p>A backup you have never restored is a hope. The drill needs only Docker and touches no live database:</p>
      <pre><code>{`aws s3 cp s3://lantern-backups/postgres/<newest>.sql.gz ./latest.sql.gz
scripts/db-restore-drill.sh ./latest.sql.gz     # restores into a throwaway pgvector container
scripts/db-restore-drill.sh --self-test         # exercises the script itself (CI runs this)`}</code></pre>
      <p>
        It restores with <code>ON_ERROR_STOP</code>, so a corrupt gzip fails, and requires the tables in{" "}
        <code>DRILL_EXPECT_TABLES</code> (default <code>agents runs journal_events</code>) to exist. Empty tables pass; set{" "}
        <code>DRILL_REQUIRE_ROWS=1</code> when you know the source has data. <code>DRILL_PG_IMAGE</code> (default{" "}
        <code>pgvector/pgvector:pg16</code>) must match the server major version. A passing run exits 0; a failing one means the
        backups are not usable until it passes. Run it monthly and after any schema or major-version change.
      </p>
      <p>
        For a real restore, stop writes (scale the control plane to 0), restore into a <em>new</em> database, re-point the release, and
        scale back up. A dump contains no roles: recreate <code>lantern_app</code> and its password, then run{" "}
        <code>DATABASE_URL=... scripts/check-app-grants.sh</code> before enabling <code>LANTERN_RLS_ENFORCE=1</code>. The full procedure
        for both topologies is <a href={`${RUNBOOKS}/db-restore.md`} target="_blank" rel="noopener noreferrer">db-restore.md</a>.
      </p>

      <h2 id="upgrade">Upgrading from the Bitnami-based chart</h2>
      <div className="callout callout-warning">
        <strong>Not an in-place upgrade.</strong> Postgres (pgvector) and the S3-compatible store (SeaweedFS) are now first-party
        templates instead of Bitnami subcharts. Their StatefulSet selectors differ, so <code>helm upgrade</code> from the old chart
        cannot adopt the existing volumes. Redis is still a Bitnami subchart (pinned by <code>Chart.lock</code>).
      </div>
      <ol>
        <li>Take a dump from the old release and keep it off the cluster (<code>pg_dump</code>, or the backup CronJob if it was on).</li>
        <li>Copy any objects you need out of the old object store.</li>
        <li><code>helm uninstall</code> the old release, then <code>helm install</code> the new chart.</li>
        <li>Restore the dump into the new database, recreate <code>lantern_app</code>, and verify with the drill above.</li>
      </ol>
      <p>
        On production values this does not apply to your data: <code>values-prod.yaml</code> uses external Postgres and S3, which the
        chart never owned. Plan the cutover for the in-cluster stores only.
      </p>

      <h2 id="demo">Kiosk and demo deployments</h2>
      <p>
        <code>make demo</code> (or <code>lantern demo</code>) runs the stack in kiosk mode on Docker alone: every visitor gets a private
        throwaway workspace, a fixture LLM, and no sign-up. See <Link href="/demo">Demo mode</Link> for the tour.
      </p>
      <pre><code>{`make demo         # then open http://localhost:3001/kiosk
make demo-down    # stop it and delete its data
lantern demo --no-open    # same stack from the CLI, without opening a browser
lantern demo --down`}</code></pre>
      <p>
        For a public demo host the guard is strict: <code>LANTERN_KIOSK=1</code> refuses to start unless{" "}
        <code>LANTERN_RLS_ENFORCE=1</code>, <code>LANTERN_AUTHZ_ENFORCE=1</code> and a non-default <code>JWT_SECRET</code> are set, and under a
        production-like <code>LANTERN_ENV</code> it also needs <code>LANTERN_KIOSK_ALLOW_PROD=1</code>. Caps (workspace lifetime, concurrent
        workspaces, new workspaces per IP per hour) are the <code>LANTERN_KIOSK_*</code> variables. Do not enable kiosk mode on a
        deployment that holds real tenants.
      </p>

      <h2 id="runbooks">Runbooks</h2>
      <p>
        On-call runbooks live in the repository, each as symptom, what fired it, triage, remediation, escalate:{" "}
        <a href={`${RUNBOOKS}/control-plane-5xx.md`} target="_blank" rel="noopener noreferrer">control-plane 5xx</a>,{" "}
        <a href={`${RUNBOOKS}/run-failure-spike.md`} target="_blank" rel="noopener noreferrer">run failure spike</a>,{" "}
        <a href={`${RUNBOOKS}/budget-402-surge.md`} target="_blank" rel="noopener noreferrer">budget 402 surge</a>,{" "}
        <a href={`${RUNBOOKS}/data-plane-disconnected.md`} target="_blank" rel="noopener noreferrer">data plane disconnected</a>,{" "}
        <a href={`${RUNBOOKS}/db-saturation.md`} target="_blank" rel="noopener noreferrer">database saturation</a>,{" "}
        <a href={`${RUNBOOKS}/scheduler-not-firing.md`} target="_blank" rel="noopener noreferrer">scheduler not firing</a>,{" "}
        <a href={`${RUNBOOKS}/gateway-latency.md`} target="_blank" rel="noopener noreferrer">gateway latency</a>,{" "}
        <a href={`${RUNBOOKS}/rls-flip.md`} target="_blank" rel="noopener noreferrer">enabling RLS enforcement</a> and{" "}
        <a href={`${RUNBOOKS}/ga-staged-rollout.md`} target="_blank" rel="noopener noreferrer">staged rollout of GA features</a>.
      </p>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>The logical backup has no point-in-time recovery: you lose every write since the last dump. It is a floor, not a recovery objective.</li>
        <li>The scheduler&apos;s readiness probe defaults to <code>/healthz</code> because <code>/readyz</code> stays unready until a runtime manager registers.</li>
        <li>HPAs are CPU-based and need metrics-server.</li>
        <li>Some runbooks still describe SLO metrics as not yet emitted; the control-plane series above now exist, and the alert rules are the source of truth.</li>
      </ul>
    </>
  );
}
