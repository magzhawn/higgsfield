# HTTP API Contract — source of truth

## Endpoints

### GET /health
Response 200: { "status": "ok", "timestamp": "<ISO string>" }

### POST /turns
Request:
{
  "session_id": "string",
  "user_id": "string | null",
  "messages": [
    { "role": "user|assistant|tool", "content": "string", "name?": "string" }
  ],
  "timestamp": "ISO-8601",
  "metadata": {}
}
Response 201: { "id": "string" }
Behavior: synchronous. 201 means turn persisted AND memories extracted AND queryable.

### POST /recall
Request: { "query": "string", "session_id": "string", "user_id": "string|null", "max_tokens": 1024 }
Response 200:
{
  "context": "## Known facts...\n- employer: works at Notion",
  "citations": [{ "turn_id": "string", "score": 0.91, "snippet": "string" }]
}
Never errors on cold session — returns { "context": "", "citations": [] }

### POST /search
Request: { "query": "string", "session_id": "string|null", "user_id": "string|null", "limit": 10 }
Response 200:
{
  "results": [{ "content": "string", "score": 0.0, "session_id": "string", "timestamp": "ISO", "metadata": {} }]
}

### GET /users/:userId/memories
Response 200:
{
  "memories": [{
    "id": "string", "type": "fact|preference|opinion|event",
    "key": "string", "value": "string", "confidence": 0.0,
    "source_session": "string", "source_turn": "string",
    "created_at": "ISO", "updated_at": "ISO",
    "supersedes": "string | null", "active": true
  }]
}
Returns ALL memories including inactive (superseded ones) — history must be preserved.

### DELETE /sessions/:sessionId
Response 204 (empty body)

### DELETE /users/:userId  
Response 204 (empty body)

## Status codes
201 — created (POST /turns only)
200 — ok
204 — no content (DELETE endpoints)
400 — bad request (malformed input, Zod validation failure)
401 — unauthorized (wrong/missing Bearer token when auth enabled)
413 — payload too large (>1MB)
500 — internal error (never expose stack traces)