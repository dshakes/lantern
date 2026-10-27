import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function SchedulingPage() {
  return (
    <>
      <h1>Scheduling</h1>
      <p>
        Run an agent on a cron expression. Schedules are their own resource, so
        one agent can have many, each with its own input and timezone. Manage
        them at <code>/v1/schedules</code>.
      </p>

      <Concept>
        &quot;Every weekday at 9am, summarize my inbox,&quot; with nobody
        clicking a button. A cron expression is five fields: minute, hour, day
        of month, month, weekday. Scheduled runs appear in the dashboard like
        any other run.
      </Concept>

      <h2 id="cron">Cron expressions</h2>
      <p>
        Five fields: minute, hour, day of month, month, day of week. Each field
        accepts <code>*</code>, lists, ranges and <code>*/N</code> steps:
      </p>
      <pre>
        <code>{`# ┌─── minute (0-59)
# │ ┌─── hour (0-23)
# │ │ ┌─── day of month (1-31)
# │ │ │ ┌─── month (1-12)
# │ │ │ │ ┌─── day of week (0-7, Sun=0 or 7)
# │ │ │ │ │
# * * * * *

0 9 * * 1-5     # every weekday at 9:00 AM (in the schedule timezone)
*/15 * * * *    # every 15 minutes
0 0 1 * *       # first day of every month at midnight`}</code>
      </pre>

      <div className="callout callout-warning">
        <strong>Day-of-month and day-of-week are ANDed.</strong> Classic Vixie
        cron fires on <em>either</em> when both are set. Lantern requires both
        to match, so <code>0 9 1-7 * 1</code> fires on the first Monday of the
        month. If you port a crontab that relied on the OR behavior, rewrite
        it as two schedules. The search for the next fire time gives up after
        two years.
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
  "inputTemplate": { "mode": "daily-digest" },
  "deliveryEmail": "me@example.com",   // optional: email the result
  "enabled": true
}

Response: 201 Created
{
  "id": "sched-uuid",
  "agentName": "research-agent",
  "cronExpr": "0 9 * * 1-5",
  "inputTemplate": { "mode": "daily-digest" },
  "deliveryEmail": "me@example.com",
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

{ "enabled": false }   // pause. Also accepts cronExpr, deliveryEmail, timezone`}</code>
      </pre>

      <h3>Delete a schedule</h3>
      <pre>
        <code>{`DELETE /v1/schedules/{id}

Response: 204 No Content`}</code>
      </pre>

      <h2 id="timezone">Timezone handling</h2>
      <p>
        <code>timezone</code> is an optional IANA name (an invalid one returns
        400). Cron then matches the schedule&apos;s local time. Resolution
        order: the schedule&apos;s zone, then{" "}
        <code>LANTERN_DEFAULT_TIMEZONE</code>, then UTC. With neither set,{" "}
        <code>0 9 * * *</code> fires at 09:00 UTC.
      </p>
      <p>
        The deployment default (not a per-schedule zone) also sets the{" "}
        <Link href="/budgets">budget</Link> day boundary: daily limits roll at
        local midnight in that zone.
      </p>

      <div className="callout callout-info">
        <strong>Surfaces trigger runs too.</strong> Inbound messages on a
        channel start runs. They are not schedules but follow the same run
        lifecycle. See{" "}
        <Link href="/surfaces">Surfaces</Link>.
      </div>
    </>
  );
}
