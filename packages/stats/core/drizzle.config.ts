import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "mysql",
  schema: ["./src/database/schema.ts"],
  out: "./migrations",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "mysql://root:changeme@localhost:3306/opencode_stats",
  },
  strict: true,
  verbose: true,
})
