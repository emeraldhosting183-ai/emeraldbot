export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenPrices {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function estimateCostUsd(usage: TokenUsage, prices: TokenPrices): number {
  return (
    (usage.inputTokens * prices.inputPerMillion +
      usage.outputTokens * prices.outputPerMillion) /
    1_000_000
  );
}
