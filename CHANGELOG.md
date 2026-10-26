# Changelog

For teachers who run their own copy. Each release lists what is new, what (if anything) you must do, and whether it is safe to apply without thinking. Updating is always: `git pull`, then `node setup.mjs upgrade` (or ask the teacher MCP: "plan an update").

## 1.0.0

- First release: student sites, tokens, teacher page, student backends, class AI (OpenRouter, Google Gemini through a platform proxy), class storage, student kit and MCP package.
- New: `node setup.mjs` installs the whole platform into your own AWS account (no SAM CLI needed), `plan` / `apply` / `upgrade` update it, and the teacher MCP (`class-platform-teacher-mcp`) does the same from your AI editor.
- Teacher action needed: none (first release).
- Breaking changes: none.
