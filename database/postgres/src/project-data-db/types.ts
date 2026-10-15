/**
 * Shared types and schemas for database operations
 * Using Zod v4 for validation
 */

import { z } from 'zod';

/**
 * Component schema - represents a UI component configuration
 */
export const ComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

export type Component = z.infer<typeof ComponentSchema>;

/**
 * UIBlock schema - unified structure for both bookmarks and user-conversations
 *
 * Fields:
 * - id: Unique identifier for the UIBlock
 * - component: The generated component configuration
 * - analysis: The text/analysis response from LLM
 * - user_prompt: The original user question/prompt
 */
export const UIBlockSchema = z.object({
  id: z.string(),
  component: ComponentSchema.nullable(),
  analysis: z.string().nullable(),
  user_prompt: z.string(),
});

export type UIBlock = z.infer<typeof UIBlockSchema>;

/**
 * Helper function to create a UIBlock object
 */
export function createUIBlock(params: {
  id: string;
  component: Component | null;
  analysis: string | null;
  user_prompt: string;
}): UIBlock {
  return UIBlockSchema.parse(params);
}

/**
 * Helper function to validate a UIBlock object
 */
export function validateUIBlock(data: unknown): { success: boolean; data?: UIBlock; error?: string } {
  const result = UIBlockSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}
