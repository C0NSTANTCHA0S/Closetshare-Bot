# Closet Share Bot — Agent Instructions

## Project goals
This is a Discord bot for Closet Share. Keep the codebase maintainable, predictable, and easy to extend.

## Core architecture rules
- Keep all slash command registration centralized in `register-commands.js`.
- Runtime command loading must stay aligned with registration.
- Shared Discord utility logic belongs in `src/core/discord-helpers.js`.
- Shared environment loading belongs in `src/core/env.js` or one shared loader only.
- Shared configuration belongs in `src/core/config.js`.
- Shared database helpers belong in `src/core/shared-db.js` or other `src/core/*` modules.
- Feature files should stay lean. If logic is duplicated across features, move it into shared helpers.
- Do not hardcode IDs, tokens, channel IDs, role IDs, or image URLs that belong in `.env`.

## Commands and features
- Every slash command that exists in a feature must also be registered through `register-commands.js`.
- Do not create hidden or unregistered commands.
- If adding a new command, update both runtime wiring and registration wiring in the same change.
- If changing permissions, keep permission logic consistent across registration and runtime checks.

## Environment and secrets
- Never commit real secrets.
- `.env` must never be committed.
- Update `.env.example` whenever adding or renaming environment variables.
- Prefer reading all env values through shared config, not directly inside feature files unless already established by project structure.

## Discord-specific rules
- Validate embed image and thumbnail URLs before applying them.
- Do not call Discord embed setters with null or invalid values.
- When Discord rejects a payload, log enough detail to diagnose the exact field that failed.
- Keep button custom IDs stable unless a migration is intentional.
- Respect Discord message, embed, and component limits.

## Database rules
- Prefer migrations or additive schema changes over destructive rewrites.
- Keep data compatibility in mind for existing SQLite files.
- Do not silently change storage formats without migration handling.

## Coding style
- Make the smallest safe change first.
- Preserve existing behavior unless the task explicitly asks to change behavior.
- Avoid large rewrites when a targeted refactor is enough.
- Keep functions focused and readable.
- Reuse helpers instead of duplicating logic.

## Verification
Before considering work done:
- Check for syntax errors.
- Verify all changed imports resolve.
- Verify command registration still includes all live slash commands.
- Verify new env variables are represented in `.env.example`.
- Verify no secrets were added to tracked files.

## When working on this repo
For larger tasks:
1. Audit the relevant files first.
2. Identify the smallest coordinated set of changes.
3. Explain structural risks before rewriting architecture.
4. Keep compatibility with the current bot unless told otherwise.
