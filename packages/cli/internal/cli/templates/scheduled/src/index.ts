import { agent, step } from "@lantern/sdk";

interface DataRecord {
  date: string;
  metric: string;
  value: number;
}

interface AnalysisResult {
  trends: string[];
  anomalies: string[];
  recommendation: string;
}

export default agent({
  name: "{{.Name}}",
  async run({ input, ctx }) {
    const dataSource = input.dataSource ?? "https://api.example.com/metrics";
    const reportChannel = input.reportChannel ?? "#weekly-report";

    // Step 1: Fetch data from the configured source.
    const rawData = await step("fetch-data", async () => {
      const response = await ctx.tools.httpRequest({
        url: dataSource,
        method: "GET",
        headers: {
          Authorization: `Bearer ${ctx.secrets.get("DATA_API_KEY")}`,
        },
      });

      const records: DataRecord[] = response.json();
      ctx.log.info("Data fetched", { recordCount: records.length });
      return records;
    });

    // Step 2: Transform and clean the data.
    const cleanedData = await step("transform-data", async () => {
      const result = await ctx.tools.pythonExec({
        code: `
import json
from datetime import datetime

raw = json.loads('''${JSON.stringify(rawData)}''')

# Deduplicate and sort by date.
seen = set()
cleaned = []
for record in raw:
    key = f"{record['date']}_{record['metric']}"
    if key not in seen:
        seen.add(key)
        cleaned.append(record)

cleaned.sort(key=lambda x: x["date"])

# Compute rolling averages per metric.
metrics = {}
for record in cleaned:
    m = record["metric"]
    if m not in metrics:
        metrics[m] = []
    metrics[m].append(record["value"])

summary = {}
for m, values in metrics.items():
    summary[m] = {
        "count": len(values),
        "mean": sum(values) / len(values) if values else 0,
        "min": min(values) if values else 0,
        "max": max(values) if values else 0,
    }

print(json.dumps({"cleaned": cleaned, "summary": summary}))
`,
      });

      return JSON.parse(result.stdout);
    });

    // Step 3: Analyze trends and anomalies with the LLM.
    const analysis = await step("analyze", async () => {
      const result = await ctx.llm.complete({
        prompt: `You are a data analyst. Review the following weekly metrics summary and identify trends, anomalies, and provide a recommendation.

Data Summary:
${JSON.stringify(cleanedData.summary, null, 2)}

Total Records: ${cleanedData.cleaned.length}

Return JSON with:
- "trends": array of observed trend descriptions
- "anomalies": array of any anomalies or concerns
- "recommendation": a single actionable recommendation`,
      });
      return result as AnalysisResult;
    });

    // Step 4: Distribute the report to stakeholders.
    const report = await step("distribute-report", async () => {
      const reportText = [
        `*Weekly Data Report* — ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
        "",
        "*Trends:*",
        ...analysis.trends.map((t: string) => `  - ${t}`),
        "",
        "*Anomalies:*",
        ...(analysis.anomalies.length > 0
          ? analysis.anomalies.map((a: string) => `  :warning: ${a}`)
          : ["  None detected."]),
        "",
        `*Recommendation:* ${analysis.recommendation}`,
        "",
        `_Metrics summary: ${Object.keys(cleanedData.summary).length} metrics across ${cleanedData.cleaned.length} data points._`,
      ].join("\n");

      // Post to Slack.
      await ctx.connectors.slack.postMessage({
        channel: reportChannel,
        text: reportText,
      });

      // Also store the report for future reference.
      await ctx.tools.fileWrite({
        path: `/workspace/reports/weekly-${new Date().toISOString().slice(0, 10)}.md`,
        content: reportText,
      });

      ctx.log.info("Report distributed", { channel: reportChannel });
      return reportText;
    });

    return {
      recordsProcessed: cleanedData.cleaned.length,
      metricsAnalyzed: Object.keys(cleanedData.summary).length,
      trends: analysis.trends.length,
      anomalies: analysis.anomalies.length,
      reportDistributed: true,
    };
  },
});
