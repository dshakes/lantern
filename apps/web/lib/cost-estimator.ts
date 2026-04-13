// ---------------------------------------------------------------------------
// Cost Estimator — estimate token usage and cost before running
// ---------------------------------------------------------------------------

// Approximate pricing per 1M tokens (input / output)
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number; label: string }> = {
  auto: { inputPer1M: 3, outputPer1M: 15, label: "Auto (Claude Sonnet)" },
  "reasoning-frontier": { inputPer1M: 15, outputPer1M: 75, label: "Claude Opus 4" },
  "reasoning-large": { inputPer1M: 3, outputPer1M: 15, label: "Claude Sonnet 4" },
  "reasoning-small": { inputPer1M: 0.8, outputPer1M: 4, label: "Claude Haiku 4" },
  "code-large": { inputPer1M: 3, outputPer1M: 15, label: "Claude Sonnet 4" },
  "chat-large": { inputPer1M: 2.5, outputPer1M: 10, label: "GPT-4o" },
  "chat-small": { inputPer1M: 0.15, outputPer1M: 0.6, label: "GPT-4o Mini" },
  "vision-large": { inputPer1M: 1.25, outputPer1M: 5, label: "Gemini 2.5 Pro" },
};

// Rough token estimation: ~4 chars per token for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CostEstimate {
  inputTokens: number;
  estimatedOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  modelLabel: string;
}

export function estimateCost(systemPrompt: string, userInput: string, model: string): CostEstimate {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.auto;
  const inputTokens = estimateTokens(systemPrompt + userInput);
  // Assume output is roughly 2x input for a typical agent response, capped at 2000
  const estimatedOutputTokens = Math.min(inputTokens * 2, 2000);
  const totalTokens = inputTokens + estimatedOutputTokens;
  const estimatedCost = (inputTokens * pricing.inputPer1M + estimatedOutputTokens * pricing.outputPer1M) / 1_000_000;

  return {
    inputTokens,
    estimatedOutputTokens,
    totalTokens,
    estimatedCost,
    modelLabel: pricing.label,
  };
}

export function formatEstimate(est: CostEstimate): string {
  const tokens = est.totalTokens < 1000 ? `~${est.totalTokens}` : `~${(est.totalTokens / 1000).toFixed(1)}k`;
  const cost = est.estimatedCost < 0.001 ? "<$0.001" : `$${est.estimatedCost.toFixed(3)}`;
  return `Estimated: ${tokens} tokens / ${cost}`;
}
