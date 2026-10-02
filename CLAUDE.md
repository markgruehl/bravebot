# bravebot

A small Discord bot that posts to a guild's system channel (and optionally a Slack webhook) whenever a member connects to, disconnects from, or moves between voice channels.

## Git workflow (required)

- **Never work on `main` directly.** Every change gets its own branch in its own git worktree and reaches `main` only through a pull request.
- Create worktrees under `.claude/worktrees/` (this path is gitignored):
  ```sh
  git fetch origin
  git worktree add -b <type>/<short-name> .claude/worktrees/<short-name> origin/main
  ```
  Branch prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.
- Use Conventional Commits with a scope, matching the existing history: `feat(bot): ...`, `chore(deps): ...`.
- Push the branch, then open a PR against `main`: `gh pr create --base main`.
- After the PR merges, clean up: `git worktree remove .claude/worktrees/<short-name> && git branch -d <branch>`.
- `.claude/hooks/guard-main.sh` blocks `git commit`/`git push` on `main` and any push that targets `main`. Don't bypass it.

## Current state

- `main.py` is a `discord.py` Gateway client run as a Docker container (`Dockerfile`, `docker-compose.yaml`). The image is published to Docker Hub when a GitHub release is published (`.github/workflows/ci.yaml`).
- Config is read from env vars (see `.env.example`): `DISCORD_BOT_TOKEN` and `SLACK_WEBHOOK` (optional).
- There are no tests yet.

## Planned direction: Cloudflare Workers + TypeScript

We're migrating to Cloudflare Workers in TypeScript. Architectural constraints to keep in mind:

- Discord only delivers `VOICE_STATE_UPDATE` over the **Gateway WebSocket**. HTTP interactions and webhook events don't carry it. A plain stateless Worker can't receive it.
- The Gateway connection therefore lives in a **Durable Object** that opens an outbound WebSocket. It handles HELLO/heartbeat, IDENTIFY, and RESUME, and uses a DO alarm as a watchdog to reconnect after eviction or a deploy.
- `VOICE_STATE_UPDATE` only contains the *new* state, so the DO must track each member's current channel itself, seeded from `GUILD_CREATE.voice_states`.
- Outbound notifications go through Discord REST (`POST /channels/{id}/messages`) and the Slack webhook via `fetch`.
- Secrets go in `wrangler secret put`, never in `wrangler.jsonc` or the repo.

### Cost guardrails (Workers Paid plan)

The Gateway DO can't hibernate (outbound WebSockets never do), so it bills duration 24/7: about 324k–335k GB-s/month against 400k included. That leaves room for **one** always-on object, so:

- **Exactly one Gateway DO.** Always address it with `getByName("gateway")`, never `newUniqueId()`. Each extra always-connected instance costs another ~330k GB-s/month.
- **Reconnects use exponential backoff with a cap.** Track identifies, because Discord allows 1000 per day and resets the bot token if you exceed that. Prefer RESUME over IDENTIFY.
- **Don't write to storage on every Gateway message.** Persist `seq` in batches (on the alarm tick or every N events) and persist voice state only when it changes.
- **Keep the alarm watchdog at about 60s or slower.** A cron trigger is only a bootstrap, so run it at most every 5 minutes.
- **The public interactions endpoint verifies the Ed25519 signature first** and rejects bad requests before doing any other work.
- Use `pnpm`.
