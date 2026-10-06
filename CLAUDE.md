# bravebot

A small Discord bot for a friends' server. It posts to a guild's system channel (and optionally a Slack webhook) whenever a member connects to, disconnects from, or moves between voice channels, and replies `pong` to `ping`.

## Git workflow

- Don't work on `main` directly. Every change gets its own branch and reaches `main` only through a pull request.
- Prefer a git worktree per branch, under `.claude/worktrees/` (gitignored and dockerignored):
  ```sh
  git fetch origin
  git worktree add --no-track -b <type>/<short-name> .claude/worktrees/<short-name> origin/main
  ```
  `--no-track` keeps the new branch from tracking `origin/main`, so a bare `git push` can't land on `main`.
  Branch prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.
- Use Conventional Commits with a scope, matching the existing history: `feat(bot): ...`, `chore(deps): ...`.
- Push with `git push -u origin HEAD`, then open a PR against `main`: `gh pr create --base main`.
- After the PR merges, clean up: `git worktree remove .claude/worktrees/<short-name>`, then `git branch -D <branch>` (`-D` because squash/rebase merges leave the branch looking unmerged).

## Architecture

- `main.py` is a single-file `discord.py` Gateway client (`BraveBot(discord.Client)`). It enables the `message_content` and `voice_states` intents. `message_content` is privileged, so it must also be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents).
- Config comes from env vars (see `.env.example`): `DISCORD_BOT_TOKEN` (required) and `SLACK_WEBHOOK` (meant to be optional).
- Dependencies are pinned in `requirements.txt`. `discord.py==2.2.2` imports `audioop`, which was removed in Python 3.13, so use Python 3.11 (matching the image) or 3.12.
- Lint with `uvx ruff check .` (config in `pyproject.toml`; nothing runs it automatically). `main.py` already has violations, so don't mass-fix unrelated code in a feature PR.
- There are no tests yet.

### Known bugs in `main.py`

- The Slack guard `if SLACK_WEBHOOK is not None or SLACK_WEBHOOK != ""` is always true. When `SLACK_WEBHOOK` is unset or empty, `requests.post` raises before the Discord message is sent, so in practice `SLACK_WEBHOOK` is required for voice notifications. It should be `if SLACK_WEBHOOK:`.
- The early return `if guild.system_channel is None and member.bot` should use `or`. Today a guild without a system channel crashes on `.send`, and bots' voice changes are announced.

## Running and deploying (Docker)

The bot runs as a long-lived Docker container. That's the deployment target; there are no plans to move it to a serverless platform.

- `Dockerfile`: multi-stage build on `python:3.11.2-slim`; installs `requirements.txt`, copies the repo, then runs `python3 main.py`.
- `docker-compose.yaml`: builds the image and bind-mounts the repo into `/usr/src/app`, so local code changes apply on a container restart without a rebuild. It doesn't pass any env vars; add `env_file: .env` to the service or use `docker compose run -e DISCORD_BOT_TOKEN=... bot`.
- Run locally without Docker:
  ```sh
  python3.11 -m venv .venv && . .venv/bin/activate
  pip install -r requirements.txt
  DISCORD_BOT_TOKEN=... SLACK_WEBHOOK=... python main.py
  ```
- Releases: publishing a GitHub release triggers `.github/workflows/ci.yaml`, which builds the image and pushes `<DOCKERHUB_USERNAME>/bravebot:latest` and `<DOCKERHUB_USERNAME>/bravebot:<release name>` (`marksansome11/bravebot` on Docker Hub). The image tag comes from the release **title**, not the git tag, so always pass a tag-safe title: `gh release create v1.2.0 --title v1.2.0`. Publishing a release is outward-facing, so confirm before running it.
- Never commit `.env` or tokens. Secrets for CI (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`) live in GitHub Actions secrets.
