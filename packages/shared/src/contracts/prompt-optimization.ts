import { z } from "zod";
import { AgentName, ModelSelection } from "./provider";

export const MAX_PROMPT_OPTIMIZATION_CHARS = 24_000;

const promptText = z
  .string()
  .min(1)
  .max(MAX_PROMPT_OPTIMIZATION_CHARS)
  .refine((value) => value.trim().length > 0, { message: "提示词不能为空" });

export const PromptOptimizationRequest = z.object({
  text: promptText,
  agent: AgentName,
  modelSelection: ModelSelection,
});
export type PromptOptimizationRequest = z.infer<typeof PromptOptimizationRequest>;

export const PromptOptimizationResponse = z.object({
  optimizedText: promptText,
});
export type PromptOptimizationResponse = z.infer<typeof PromptOptimizationResponse>;
