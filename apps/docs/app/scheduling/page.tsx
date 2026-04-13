export default function SchedulingPage() {
  return (
    <>
      <h1>Scheduling</h1>
      <p>
        Lantern agents can be scheduled to run automatically on a recurring
        basis using cron expressions. You can also configure agents to deliver
        results via email or webhooks after each run.
      </p>

      <h2>Cron expressions</h2>
      <p>
        Schedules use standard cron syntax with five fields:
      </p>
      <pre>
        <code>{`# ┌─── minute (0-59)
# │ ┌─── hour (0-23)
# │ │ ┌─── day of month (1-31)
# │ │ │ ┌─── month (1-12)
# │ │ │ │ ┌─── day of week (0-6, Sun=0)
# │ │ │ │ │
# * * * * *

# Examples:
0 9 * * 1-5    # Every weekday at 9:00 AM
*/15 * * * *   # Every 15 minutes
0 0 1 * *      # First day of every month at midnight
30 8 * * 1     # Every Monday at 8:30 AM`}</code>
      </pre>

      <h3>Setting up a schedule</h3>
      <ol>
        <li>
          Open the agent&apos;s detail page in the dashboard
        </li>
        <li>
          Go to the <strong>Schedule</strong> tab
        </li>
        <li>
          Enter a cron expression or use the visual schedule builder
        </li>
        <li>
          Optionally set the input payload for each scheduled run
        </li>
        <li>
          Click <strong>Save schedule</strong>
        </li>
      </ol>
      <p>[Screenshot: Schedule configuration with cron builder]</p>

      <h2>AI-assisted cron</h2>
      <p>
        Not sure about cron syntax? Describe your schedule in plain English and
        Lantern will generate the cron expression for you:
      </p>
      <pre>
        <code>{`"Every weekday at 9am"          → 0 9 * * 1-5
"Every 2 hours during business"  → 0 */2 9-17 * * 1-5
"First Monday of each month"     → 0 9 1-7 * 1`}</code>
      </pre>
      <p>
        In the schedule builder, click <strong>Describe in English</strong>,
        type your desired schedule, and the AI will generate the cron expression.
        You can review and adjust before saving.
      </p>

      <div className="callout callout-tip">
        <strong>Tip:</strong> The schedule builder shows a preview of the next
        5 scheduled runs so you can verify the schedule is correct before
        saving.
      </div>

      <h2>Email delivery</h2>
      <p>
        Agents can email their results after each scheduled run. This is useful
        for daily digests, reports, and monitoring alerts.
      </p>
      <ol>
        <li>
          On the <strong>Schedule</strong> tab, enable{" "}
          <strong>Email delivery</strong>
        </li>
        <li>
          Enter one or more recipient email addresses
        </li>
        <li>
          Choose a delivery format: <strong>Plain text</strong>,{" "}
          <strong>HTML</strong>, or <strong>Markdown</strong>
        </li>
        <li>
          Optionally customize the email subject template
        </li>
      </ol>
      <pre>
        <code>{`# Subject template variables:
{agent_name}    → "research-agent"
{run_date}      → "2026-04-12"
{run_status}    → "completed"

# Example subject:
"[{agent_name}] Daily report - {run_date}"`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Note:</strong> Email delivery requires a configured email
        connector (SMTP or Gmail). See{" "}
        <a href="/connectors">Connectors</a> for setup instructions.
      </div>

      <h2>Webhook triggers</h2>
      <p>
        In addition to cron-based scheduling, agents can be triggered by
        external webhooks. This is useful for event-driven workflows:
      </p>
      <ul>
        <li>
          <strong>GitHub webhooks</strong> -- trigger on push, PR, or issue
          events
        </li>
        <li>
          <strong>Stripe webhooks</strong> -- trigger on payment or subscription
          events
        </li>
        <li>
          <strong>Custom webhooks</strong> -- trigger from any HTTP POST
        </li>
      </ul>
      <p>
        Each agent has a unique webhook URL:
      </p>
      <pre>
        <code>{`POST https://api.lantern.run/v1/agents/my-agent/webhook
Content-Type: application/json
X-Lantern-Secret: your-webhook-secret

{
  "event": "push",
  "repository": "org/repo",
  "ref": "refs/heads/main"
}`}</code>
      </pre>
      <p>
        The webhook payload is passed as the agent&apos;s input. You can
        configure the webhook secret in the agent&apos;s{" "}
        <strong>Configuration</strong> tab.
      </p>

      <h2>Schedule management</h2>
      <p>
        From the dashboard, you can manage all scheduled agents in one place:
      </p>
      <ul>
        <li>
          <strong>Pause/resume</strong> -- temporarily stop a schedule without
          deleting it
        </li>
        <li>
          <strong>Run history</strong> -- view all past scheduled runs with
          status and timing
        </li>
        <li>
          <strong>Next run</strong> -- see when the next scheduled execution
          will happen
        </li>
        <li>
          <strong>Manual trigger</strong> -- run a scheduled agent on demand
          outside its schedule
        </li>
      </ul>

      <h2>Timezone handling</h2>
      <p>
        Schedules default to UTC. You can set a timezone per schedule:
      </p>
      <pre>
        <code>{`{
  "cron": "0 9 * * 1-5",
  "timezone": "America/New_York"
}`}</code>
      </pre>
      <p>
        The scheduler automatically handles daylight saving time transitions.
      </p>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Be careful with schedules that run more
        frequently than every 5 minutes. Each run consumes compute resources
        and LLM tokens. Monitor your usage in the dashboard.
      </div>
    </>
  );
}
