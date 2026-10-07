# bravebot

A Discord bot for a friends' server, written in TypeScript (discord.js v14 + @discordjs/voice) and run as a Docker container. Its features:

- **Soundboard:** play an uploaded file, a URL (direct audio, or YouTube/SoundCloud/etc. via yt-dlp) or a saved library sound into the caller's voice channel, with interrupt/queue modes, `/stop`, `/skip` and `/volume`.
- **Voice activity notices:** join/leave/move messages in the guild's system channel, optionally mirrored to Slack.
- **Ping:** replies `pong` to `ping`.

The README is the user-facing reference (commands, permissions, setup, releases). Read it before changing behavior.

## Git workflow

- Don't work on `main` directly. Every change gets its own branch and reaches `main` only through a pull request.
- Prefer a git worktree per branch, under `.claude/worktrees/` (gitignored and dockerignored):
  ```sh
  git fetch origin
  git worktree add --no-track -b <type>/<short-name> .claude/worktrees/<short-name> origin/main
  ```
  `--no-track` keeps the new branch from tracking `origin/main`, so a bare `git push` can't land on `main`.
  Branch prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.
- Use Conventional Commits. They drive releases: `feat:` → minor, `fix:` → patch, `feat!:`/`BREAKING CHANGE:` → major; `chore:`, `ci:`, `docs:`, `refactor:` don't release.
- Push with `git push -u origin HEAD`, then open a PR against `main`: `gh pr create --base main`.
- After the PR merges, clean up: `git worktree remove .claude/worktrees/<short-name>`, then `git branch -D <branch>` (`-D` because squash/rebase merges leave the branch looking unmerged).

## Architecture

- `src/index.ts` wires the client (intents: Guilds, GuildVoiceStates, GuildMessages, MessageContent; MessageContent is privileged and must be enabled in the Developer Portal). `src/types.ts` holds the shared contracts; `src/config.ts` reads env (`DISCORD_BOT_TOKEN` required, `SLACK_WEBHOOK` optional).
- Soundboard: `src/playback/` (source validation, yt-dlp/ffmpeg pipeline, pure queue state machine in `queue.ts`, per-guild player), `src/library/` (saved sounds), `src/guild/` (channel setup and the admin log), `src/interactions/` (commands, panel, context menu, permission checks).
- Voice activity: `src/voice-activity/` (`notices.ts`, `slack.ts`). Ping: `src/ping/`.
- **Stateless:** nothing is written to local disk. Saved sounds live as bot messages in a private `#soundboard-library` channel and the admin log in `#soundboard-log`, both found by a topic marker and rebuilt on startup. Discord attachment URLs expire, so never cache them long-term.
- Keep Discord-API code thin and put logic in pure functions with `*.test.ts` next to them.

## Commands

```sh
npm ci                 # install (CI uses --ignore-scripts; the checks don't need the native opus build)
npm run dev            # tsx watch; reads .env if present
npm run typecheck && npm run lint && npm test && npm run build
docker compose up --build
```

Local dev also needs ffmpeg and yt-dlp on `PATH` (`pip install --require-hashes -r docker/requirements.txt`).

## Dependencies

- Everything is pinned exactly: npm versions (`.npmrc` has `save-exact`), the hash-pinned yt-dlp lockfile (regenerate with the `pip-compile` command in `docker/requirements.in`), the base image by digest, actions by SHA, and the tool pins at the top of `.github/workflows/main.yaml`. Keep it that way when adding anything.
- Renovate (`renovate.json`) bumps the pins. Runtime updates use `fix(deps)`, tooling `chore(deps)`. Node stays on 22 LTS.
- `@discordjs/opus` is compiled from source in the Dockerfile's `prod-deps` stage; see the comments there before changing that stage.

## Releases and images

- Never create releases or push images by hand (`gh release create`, `docker push`). A manual release doesn't build an image and collides with release-please's versioning.
- `.github/workflows/main.yaml` runs only on pushes to `main`: checks → release-please → native amd64/arm64 image builds. Every passing push publishes `edge`; merging the release-please PR cuts `vX.Y.Z` and the same image also gets `X.Y.Z`, `X.Y`, `X` and `latest`.
- Never commit `.env` or tokens. CI secrets (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`) live in GitHub Actions secrets.
