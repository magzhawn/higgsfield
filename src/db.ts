import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"

const DB_PATH = process.env.DB_PATH ?? "/app/data/memory.db"

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH, { create: true })

let initialized = false

export function initDb(): void {
  if (initialized) return
  initialized = true
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA foreign_keys=ON")
  db.run("PRAGMA synchronous=NORMAL")

  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      user_id     TEXT,
      messages    TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      metadata    TEXT DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      turn_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      confidence  REAL DEFAULT 1.0,
      implicit    INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      supersedes  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id        TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      vector    BLOB NOT NULL
    )
  `)

  db.run("CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, active)")
  db.run("CREATE INDEX IF NOT EXISTS idx_memories_key  ON memories(user_id, key, active)")
  db.run("CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)")

  console.log(`DB ready at ${DB_PATH}`)
}

// Tables must exist before preparing statements
initDb()

// ── Prepared statements (private) ────────────────────────────────────────────

export const q = {
  insertTurn: db.query(`
    INSERT INTO turns (id, session_id, user_id, messages, timestamp, metadata)
    VALUES ($id, $session_id, $user_id, $messages, $timestamp, $metadata)
  `),

  insertMemory: db.query(`
    INSERT INTO memories (id, user_id, session_id, turn_id, type, key, value, confidence, implicit, supersedes)
    VALUES ($id, $user_id, $session_id, $turn_id, $type, $key, $value, $confidence, $implicit, $supersedes)
  `),

  insertEmbedding: db.query(`
    INSERT INTO embeddings (id, memory_id, vector)
    VALUES ($id, $memory_id, $vector)
  `),

  getMemoriesByUser: (userId: string) =>
    db.query(`
      SELECT m.*, e.vector
      FROM memories m
      LEFT JOIN embeddings e ON e.memory_id = m.id
      WHERE m.user_id = $userId AND m.active = 1
      ORDER BY m.created_at DESC
    `).all({ $userId: userId }),

  getAllMemoriesByUser: (userId: string) =>
    db.query(`
      SELECT * FROM memories
      WHERE user_id = $userId
      ORDER BY created_at ASC
    `).all({ $userId: userId }),

  getMemoryByKey: (userId: string, key: string) =>
    db.query(`
      SELECT m.*, e.vector
      FROM memories m
      LEFT JOIN embeddings e ON e.memory_id = m.id
      WHERE m.user_id = $userId AND m.key = $key AND m.active = 1
      LIMIT 1
    `).get({ $userId: userId, $key: key }),

  supersedeMemory: (id: string) =>
    db.query(`
      UPDATE memories SET active = 0, updated_at = datetime('now') WHERE id = $id
    `).run({ $id: id }),

  getTurnsBySession: (sessionId: string) =>
    db.query(`
      SELECT * FROM turns WHERE session_id = $sessionId ORDER BY created_at ASC
    `).all({ $sessionId: sessionId }),

  deleteSession: db.transaction((sessionId: string) => {
    db.query(`
      DELETE FROM embeddings WHERE memory_id IN (
        SELECT id FROM memories WHERE session_id = $sessionId
      )
    `).run({ $sessionId: sessionId })
    db.query("DELETE FROM memories WHERE session_id = $sessionId").run({ $sessionId: sessionId })
    db.query("DELETE FROM turns WHERE session_id = $sessionId").run({ $sessionId: sessionId })
  }),

  deleteUser: db.transaction((userId: string) => {
    db.query(`
      DELETE FROM embeddings WHERE memory_id IN (
        SELECT id FROM memories WHERE user_id = $userId
      )
    `).run({ $userId: userId })
    db.query("DELETE FROM memories WHERE user_id = $userId").run({ $userId: userId })
    db.query("DELETE FROM turns WHERE user_id = $userId").run({ $userId: userId })
  }),
}

export const tx = (fn: () => void) => db.transaction(fn)()
