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
  disable_graph: z.boolean().optional().default(false),
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
