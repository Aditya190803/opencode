# OpenCode Stats

Stats is a separate site from the console. The initial scaffold keeps runtime and database code in `core` and the SolidStart website in `app`.

## Packages

- `app`: SolidStart frontend/site.
- `core`: Effect services, app config, and Drizzle schema/migration stubs.

## Commands

- `bun run dev:stats` from the repo root starts the SolidStart app.
- `bun run --cwd packages/stats/app typecheck` typechecks the site.
- `bun run --cwd packages/stats/core typecheck` typechecks the Effect/database package.
