# Database Schema

Engine: bun:sqlite
File: process.env.DB_PATH ?? "/app/data/memory.db"
PRAGMAs: journal_mode=WAL, foreign_keys=ON, synchronous=NORMAL

## Tables

### turns
id          TEXT PRIMARY KEY
session_id  TEXT NOT NULL
user_id     TEXT
messages    TEXT NOT NULL        -- JSON.stringify(Message[])
timestamp   TEXT NOT NULL
metadata    TEXT DEFAULT '{}'    -- JSON.stringify(object)
created_at  TEXT DEFAULT (datetime('now'))

### memories
id          TEXT PRIMARY KEY
user_id     TEXT NOT NULL
session_id  TEXT NOT NULL
turn_id     TEXT NOT NULL        -- FK → turns.id
type        TEXT NOT NULL        -- "fact"|"preference"|"opinion"|"event"
key         TEXT NOT NULL        -- snake_case canonical topic key
value       TEXT NOT NULL        -- descriptive phrase, never raw message text
confidence  REAL DEFAULT 1.0
implicit    INTEGER DEFAULT 0    -- 1 = inferred, not directly stated
active      INTEGER DEFAULT 1    -- 0 = superseded by newer memory
supersedes  TEXT                 -- id of memory this replaced (history chain)
created_at  TEXT DEFAULT (datetime('now'))
updated_at  TEXT DEFAULT (datetime('now'))

### embeddings
id          TEXT PRIMARY KEY
memory_id   TEXT NOT NULL        -- FK → memories.id
vector      BLOB NOT NULL        -- Float32Array packed as Buffer

## Indexes
idx_memories_user     ON memories(user_id, active)
idx_memories_key      ON memories(user_id, key, active)
idx_turns_session     ON turns(session_id)

## Transaction rule
Any operation touching more than one table MUST use db.transaction().
Pattern: db.transaction(() => { ...multi-table writes... })()

## Query API pattern (bun:sqlite)
const stmt = db.query("SELECT * FROM memories WHERE user_id = $userId AND active = 1")
stmt.all({ $userId: "user-1" })   // returns array
stmt.get({ $userId: "user-1" })   // returns first row or null
db.run("PRAGMA journal_mode=WAL") // for statements with no return value