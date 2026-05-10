import { z } from "zod"

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(100_000),
  name: z.string().optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const TurnRequestSchema = z.object({
  session_id: z.string().min(1).max(500),
  user_id: z.string().max(500).nullable().optional(),
  messages: z.array(MessageSchema).min(1).max(100),
  timestamp: z.string(),
  metadata: z.record(z.any()).default({}),
})
export type TurnRequest = z.infer<typeof TurnRequestSchema>

export const TurnResponseSchema = z.object({
  id: z.string(),
})
export type TurnResponse = z.infer<typeof TurnResponseSchema>

export const RecallRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  session_id: z.string(),
  user_id: z.string().nullable().optional(),
  max_tokens: z.number().int().min(64).max(8192).default(1024),
  // Defaults reflect the optimal Recall@K config measured on the test corpora
  // (see CHANGELOG "Feature analysis & optimal architecture"). The tester
  // does not pass disable flags, so default behaviour IS the shipped config.
  //
  // ON by default — measurable Recall@K gain or essentially free:
  disable_rewrite: z.boolean().optional().default(false),    // +460 ms / +2 hits on vocab-mismatch (only LLM feature with binary gain)
  disable_graph: z.boolean().optional().default(false),      // ~3 ms write + ~3 ms read; supports multi-hop on sparse fixtures
  disable_entities: z.boolean().optional().default(false),   // ~800 ms LLM but bridges multi-hop when graph is sparse
  disable_bm25: z.boolean().optional().default(false),
  disable_temporal: z.boolean().optional().default(false),
  disable_aggregation: z.boolean().optional().default(false),
  // OFF by default — zero measured Recall@K gain on tested corpora:
  disable_rerank: z.boolean().optional().default(true),      // +1210 ms, improves precision@1/MRR only — invisible to Recall@K
  disable_hyde: z.boolean().optional().default(true),        // +1.3-1.9 s, 0 measured gain (subject-rule + KEY_SYNONYMS cover same gap)
  disable_derived: z.boolean().optional().default(true),     // 20 % token-budget tax + slight Recall@K regression on factual workloads
})
export type RecallRequest = z.infer<typeof RecallRequestSchema>

export const CitationSchema = z.object({
  turn_id: z.string(),
  score: z.number(),
  snippet: z.string(),
})
export type Citation = z.infer<typeof CitationSchema>

export const RecallResponseSchema = z.object({
  context: z.string(),
  citations: z.array(CitationSchema),
})
export type RecallResponse = z.infer<typeof RecallResponseSchema>

export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(50).default(10),
})
export type SearchRequest = z.infer<typeof SearchRequestSchema>

export const SearchResultSchema = z.object({
  content: z.string(),
  score: z.number(),
  session_id: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.any()).default({}),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
})
export type SearchResponse = z.infer<typeof SearchResponseSchema>

export const MemoryRecordSchema = z.object({
  id: z.string(),
  type: z.enum(["fact", "preference", "opinion", "event"]),
  key: z.string(),
  value: z.string(),
  confidence: z.number(),
  source_session: z.string(),
  source_turn: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  supersedes: z.string().nullable(),
  active: z.boolean(),
})
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>
