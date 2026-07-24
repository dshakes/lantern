import Link from "next/link";

export default function SchedulingPage() {
  return (
    <>
      <h1>Scheduling</h1>
      <p>
        Schedules are a first-class resource in Lantern — separate from agents,
        so one agent can have many schedules with different inputs and timezones.
        They are managed through <code>/v1/schedules</code>.
      </p>

      <h2 id="cron">Cron expressions</h2>
      <p>
        Schedules use standard 5-field cron syntax (minute, hour, day-of-month,
        month, day-of-week):
      </p>
      <pre>
        <code>{`# ┌─── minute (0-59)
# │ ┌─── hour (0-23)
# │ │ ┌─── day of month (1-31)
# │ │ │ ┌─── month (1-12)
# │ │ │ │ ┌─── day of week (0-6, Sun=0)
# │ │ │ │ │
# * * * * *

0 9 * * 1-5     # every weekday at 9:00 AM (in the schedule timezone)
*/15 * * * *    # every 15 minutes
0 0 1 * *       # first day of every month at midnight`}</code>
      </pre>

      <div className="callout callout-warning">
        <strong>DOM + DOW footgun.</strong> When both day-of-month and
        day-of-week are non-wildcard (e.g. <code>0 9 1-7 * 1</code>), standard
        cron fires on <em>either</em> condition — not only on days that satisfy
        both. To target the first Monday of a month reliably, use a workflow
        with a conditional node, not a cron expression.
      </div>

      <h2 id="api">Schedule API</h2>

      <h3>Create a schedule</h3>
      <pre>
        <code>{`POST /v1/schedules
Content-Type: application/json

{
  "agentName": "research-agent",
  "cronExpr": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "config": { "input": { "mode": "daily-digest" } },
  "enabled": true
}

Response: 201 Created
{
  "id": "sched-uuid",
  "agentName": "research-agent",
  "cronExpr": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "enabled": true,
  "nextFireAt": "2026-07-28T13:00:00Z"
}`}</code>
      </pre>

      <h3>List schedules</h3>
      <pre>
        <code>{`GET /v1/schedules

Response: 200 OK — bare array
[
  { "id": "sched-uuid", "agentName": "...", "cronExpr": "...", "enabled": true, ... }
]`}</code>
      </pre>

      <h3>Update a schedule</h3>
      <pre>
        <code>{`PUT /v1/schedules/{id}
Content-Type: application/json

{ "enabled": false }   // pause the schedule`}</code>
      </pre>

      <h3>Delete a schedule</h3>
      <pre>
        <code>{`DELETE /v1/schedules/{id}

Response: 204 No Content`}</code>
      </pre>

      <h2 id="timezone">Timezone handling</h2>
      <p>
        Each schedule carries an optional <code>timezone</code> field (IANA,
        e.g. <code>America/New_York</code>). When set, cron matching fires at
        the schedule&apos;s local time; DST transitions are handled
        automatically. Without a per-schedule timezone, the deployment-wide
        <code>LANTERN_DEFAULT_TIMEZONE</code> applies; both unset means UTC.
      </p>
      <p>
        The same timezone logic governs the budget-enforcement day boundary:
        <code>max_cost_usd_per_day</code> rolls at local midnight, not UTC.
      </p>

      <div className="callout callout-info">
        <strong>Surfaces trigger runs too.</strong> Incoming messages on a
        WhatsApp, Slack, or webchat surface trigger a run (via{" "}
        <code>POST /v1/runs</code> under the hood) — they are not schedules but
        follow the same run lifecycle. See{" "}
        <Link href="/surfaces">Surfaces</Link>.
      </div>
    </>
  );
}
