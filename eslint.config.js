export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  text: string;
}

export interface GenerateReplyRequest {
  instructions: string;
  messages: readonly ConversationMessage[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AiGenerationResult {
  text: string;
  provider: "OPENAI" | "GEMINI";
  model: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface AiProvider {
  readonly provider: "OPENAI" | "GEMINI";
  readonly model: string;
  generateReply(request: GenerateReplyRequest): Promise<AiGenerationResult>;
  checkConnection(signal?: AbortSignal): Promise<void>;
}

export class EmptyAiResponseError extends Error {
  public constructor() {
    super("AI provider returned no text");
    this.name = "EmptyAiResponseError";
  }
}
