# talent-scout

AI talent search agent that finds candidates across LinkedIn, GitHub, Stack Overflow, and academic papers, then generates personalized outreach.

## How to run

```bash
lantern run talent-scout --input '{"role": "Senior ML Engineer", "skills": ["PyTorch", "transformers", "distributed training"], "experience": "5+ years", "location": "US / Remote", "count": 5}'
```

## Example input

```json
{
  "role": "Senior ML Engineer",
  "skills": ["PyTorch", "transformers", "distributed training"],
  "experience": "5+ years",
  "location": "US / Remote",
  "count": 5
}
```

## Input options

| Field | Type | Default | Description |
|---|---|---|---|
| `role` | string | (required) | The job title / role to search for |
| `skills` | string[] | (required) | Required technical skills |
| `experience` | string | (required) | Experience level description |
| `location` | string | `undefined` | Preferred location or "Remote" |
| `count` | number | `5` | Number of top candidates to return |

## Example output

```json
{
  "candidates": [
    {
      "name": "Sarah Chen",
      "headline": "ML Engineer at DeepMind | PyTorch contributor",
      "platform": "github",
      "profileUrl": "https://github.com/sarahchen",
      "matchScore": 94,
      "skills": ["PyTorch", "transformers", "FSDP", "CUDA", "Python"],
      "highlights": [
        "Core contributor to PyTorch distributed training module",
        "Published paper on efficient transformer fine-tuning at NeurIPS 2025",
        "Built training pipeline processing 10B tokens/day at previous role"
      ],
      "experience": "7 years in ML engineering",
      "location": "San Francisco, CA"
    }
  ],
  "outreachDrafts": [
    {
      "candidateName": "Sarah Chen",
      "subject": "Your distributed training work caught our eye",
      "body": "Hi Sarah, I came across your contributions to PyTorch's FSDP module and your NeurIPS paper on efficient fine-tuning. We're building the infrastructure for next-gen model training and your experience with distributed systems at scale is exactly what we need. Would you be open to a 20-minute chat this week?",
      "channel": "linkedin"
    }
  ],
  "searchSummary": "Strong talent pool for Senior ML Engineers with PyTorch expertise. Most candidates found on GitHub have active open-source contributions. The Bay Area and Seattle remain the primary hubs, though several strong remote candidates were identified from academic backgrounds."
}
```

## Lantern features demonstrated

- **Multi-LLM routing**: Uses `reasoning-small` for query planning (cheap), `code-large` for analyzing GitHub repos, `reasoning-large` for holistic ranking, and `chat-small` for outreach drafting
- **Cost-aware routing**: Each step uses the cheapest capable model -- outreach and query planning use `optimize: "cheap"`
- **Parallel execution**: `step.map` searches all platforms simultaneously, then analyzes all candidates in parallel
- **Durable execution**: Every step is checkpointed -- if the agent crashes mid-analysis, it resumes from the last completed step
- **Connector integration**: Notifies recruiters via Slack when results are ready
- **Structured output**: All LLM calls return validated JSON via Zod schemas
