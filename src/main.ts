import { Hono } from "hono"
import { initDb } from "./db"

initDb()

const app = new Hono()

app.get("/health", (c) => c.json({ status: "ok" }))

console.log("Memory service starting on :8080")

export default {
  port: 8080,
  fetch: app.fetch,
}
