import { HTTPException } from "hono/http-exception"
import type { Hono, MiddlewareHandler } from "hono"

export function errorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status)
    }
    console.error(err)
    return c.json({ error: "internal error" }, 500)
  })

  app.notFound((c) => c.json({ error: "not found" }, 404))
}

export const payloadSizeMiddleware: MiddlewareHandler = async (c, next) => {
  const contentLength = c.req.header("content-length")
  if (contentLength && parseInt(contentLength, 10) > 1_000_000) {
    return c.json({ error: "payload too large" }, 413)
  }
  await next()
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const token = process.env.MEMORY_AUTH_TOKEN
  if (!token) {
    await next()
    return
  }
  const header = c.req.header("authorization")
  if (header !== `Bearer ${token}`) {
    return c.json({ error: "unauthorized" }, 401)
  }
  await next()
}
