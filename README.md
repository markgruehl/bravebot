# bravebot

A multi-server Discord soundboard bot. It plays one-off audio files, links (direct audio, YouTube, SoundCloud and anything else [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports) and a saved per-server sound library into your voice channel. It also posts voice-channel activity notices.

Docker images are published on [Docker Hub](https://hub.docker.com/r/marksansome11/bravebot).

The bot is **stateless**. It keeps nothing on local disk and uses no database. Anything that has to persist, such as the sound library, is stored in Discord. In-memory indexes are rebuilt from Discord on startup and whenever the bot joins a server.

## Features

### Soundboard

- **Sources:** an uploaded audio file, a URL (a direct audio link or any page yt-dlp can extract, playlists included) or a saved library sound.
- **Plays into your voice channel.** You must be in a voice channel, and the audio plays there. You can't play into a channel you're not in.
- **Overlap:** by default a new sound **interrupts** the current one. Only the current track is replaced, so queued items still play afterwards. Choose `mode: queue` to append it instead.
- **Playlists:** every item is enqueued. The chosen mode applies to the first item, and the rest are queued after it. To queue a whole YouTube playlist, paste the playlist page link (`youtube.com/playlist?list=…`). A video link that also carries a list (`watch?v=…&list=…`) plays just that video.
- **Stage channels are not supported** (the bot would join as a muted listener). Use a regular voice channel.
- Links to private or local addresses (localhost, LAN, link-local and similar) are rejected.
- **Volume:** 0–200% (default 100%). Set it per play, or change the current track live with `/volume`.
- **One channel per server.** If the bot is already busy in a different voice channel of the server, the request is rejected.
- The bot **leaves the voice channel as soon as nothing is left to play.**
- There is no length limit.
- `/stop` also cancels a sound that is still loading (for example a large playlist that is still being read).

### Sound library

- Saved sounds live in a private, bot-created text channel, `#soundboard-library`, with one bot-authored message per sound. A message holds parseable metadata and either the re-uploaded audio file or a saved link.
- Saved links store **only the link**. They are resolved fresh with yt-dlp or a direct fetch on every play. A saved playlist link enqueues all of its items.
- Names are unique per server, case-insensitive and 1–32 characters long.
- The bot finds its channels by a marker in the channel **topic** (`bravebot:library`, `bravebot:log`), so admins can rename them safely. A channel is created only if no marked channel exists at all. A marked channel must stay private: if `@everyone` can view it, the bot will not use it and will not create a replacement either, so the soundboard stays unavailable in that server (with an explanation in the bot's logs) until **View Channel** is denied to `@everyone` again. Your saved sounds are never hidden behind a new, empty library.
- If one of these channels is deleted while the bot runs, the bot re-discovers or recreates it. A recreated library starts empty. Deleting a sound's message by hand removes that sound.
- If setup fails for a server (for example the bot lacks **Manage Channels**), commands reply that the soundboard isn't ready and the bot retries setup automatically, at most once a minute, when the soundboard is next used. Restarting the bot also retries.

### Admin log

The private channel `#soundboard-log` records:

- every play: who, what, when, which voice channel, interrupt or queue, volume and playlist item count
- stop, skip and volume actions
- library adds, renames and deletes
- failures and denials, such as not being in voice, a missing permission, the bot being busy elsewhere, a bad URL, or an extraction or playback error

For one-off uploads, only the filename and link are logged. The file is not re-attached.

### Library and log visibility

Both channels are created with `@everyone` denied **View Channel** and an explicit allow for the bot itself. Server **Administrators** can always see them. The bot does **not** sync roles. To let another role see the library or log, add a permission overwrite for that role on the channel yourself. The bot never rewrites overwrites on a channel it has already discovered.

### Voice activity notices

When a member connects to, disconnects from or moves between voice channels, the bot posts to the server's [system channel](https://support.discord.com/hc/en-us/articles/213224807), for example `@alice has connected to #General` or `@alice has changed channels from #General to #Gaming`. Mute, deafen and other same-channel changes are ignored. Bots are ignored, and nothing is posted when the server has no system channel.

If `SLACK_WEBHOOK` is set, the same notices are mirrored to Slack using plain names instead of mentions. Slack failures are logged and never crash the bot.

### ping

A message that is exactly `ping` gets the reply `pong`.

## Commands

| Command | Description | Who can use it |
| --- | --- | --- |
| `/play` | Play exactly one of `attachment`, `url` or `sound` (autocomplete). Optional `mode` (`interrupt`\|`queue`) and `volume` (0–200). | **Use Soundboard** in your voice channel |
| `/soundboard` | Shows a private, paginated button panel of library sounds. Clicking a button plays that sound. | **Use Soundboard** in your voice channel |
| Message menu → **Apps → Play in my voice channel** | Plays the first audio attachment of a message. | **Use Soundboard** in your voice channel |
| `/stop` | Stops playback and clears the queue. | Anyone in the bot's voice channel |
| `/skip` | Skips to the next queued item, or ends playback if the queue is empty. | Anyone in the bot's voice channel |
| `/volume level` | Changes the volume (0–200) of the current track. | Anyone in the bot's voice channel |
| `/sound add name (attachment\|url)` | Saves a sound to the library. | **Create Expressions** |
| `/sound rename sound name` | Renames a library sound. | **Create Expressions** for sounds you added, **Manage Expressions** for any sound |
| `/sound delete sound` | Deletes a library sound. | **Create Expressions** for sounds you added, **Manage Expressions** for any sound |

All commands work only in servers. Permissions are checked when a command runs, and every reply is ephemeral (visible only to you). Commands are registered globally on startup, and Discord may take a few minutes to show new or changed commands.

## Discord setup

1. Create an application at <https://discord.com/developers/applications> and add a **Bot**.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The `ping` → `pong` feature needs it.
3. Copy the bot token into `DISCORD_BOT_TOKEN`.
4. Invite the bot with the **`bot`** and **`applications.commands`** scopes and the permissions below:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=3263504
   ```

### Gateway intents

| Intent | Why |
| --- | --- |
| `Guilds` | Servers, channels and slash commands |
| `GuildVoiceStates` | Finding the caller's voice channel and posting voice notices |
| `GuildMessages` | Receiving `ping` messages |
| `MessageContent` (privileged) | Reading message content for `ping` |

### Bot permissions (`3263504`)

| Permission | Why |
| --- | --- |
| Manage Channels | Creating `#soundboard-library` and `#soundboard-log` |
| View Channels | Seeing channels, including its own private ones |
| Send Messages | Library entries, the admin log, voice notices and `pong` |
| Embed Links | Library and log messages |
| Attach Files | Re-uploading saved sound files to the library |
| Read Message History | Rebuilding the library index and fetching fresh attachment URLs |
| Connect | Joining voice channels |
| Speak | Playing audio |

The bot also needs to be able to view and send in the server's system channel for voice notices.

## Configuration

Configuration comes only from environment variables (see [`.env.example`](.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `SLACK_WEBHOOK` | no | Slack incoming-webhook URL for mirroring voice notices. Leave it empty or unset to disable. |

## Running

### Docker (recommended)

```sh
docker run -d --name bravebot --restart unless-stopped \
  -e DISCORD_BOT_TOKEN=... \
  -e SLACK_WEBHOOK=... \
  marksansome11/bravebot:latest
```

Images are multi-arch (`linux/amd64`, `linux/arm64`), run as an unprivileged user and use `tini` as init (no `--init` flag needed). They include Node.js 22, ffmpeg and a pinned yt-dlp (with its YouTube challenge solver, using Node.js as the JavaScript runtime). The tags are `X.Y.Z`, `X.Y`, `X` and `latest`.

### Docker Compose (local)

```sh
cp .env.example .env   # fill in DISCORD_BOT_TOKEN
docker compose up --build
```

## Local development

Requirements: Node.js 22 (>= 22.12), npm, plus **ffmpeg** and **yt-dlp** on your `PATH`. Install yt-dlp with `pip install -r docker/requirements.txt` to use the same version as the image. YouTube extraction also needs a JavaScript runtime, which you can enable for Node.js with `--js-runtimes node` in your yt-dlp config (see [`docker/yt-dlp.conf`](docker/yt-dlp.conf)).

```sh
npm ci
cp .env.example .env   # fill in DISCORD_BOT_TOKEN
npm run dev            # tsx watch, loads .env

npm run typecheck
npm run lint
npm test
npm run build && npm start
```

Source layout:

| Path | Contents |
| --- | --- |
| `src/index.ts` | Entry point and event wiring |
| `src/playback/` | Source resolution (yt-dlp/ffmpeg), the pure queue state machine and the per-server player |
| `src/library/` | Library message format, name validation and the Discord-backed store |
| `src/guild/` | Channel discovery and creation, and the admin log |
| `src/interactions/` | Slash commands, the button panel, the context menu, autocomplete and permission checks |
| `src/legacy/` | Voice notices, the Slack mirror and ping |

Unit tests are `*.test.ts` files that sit next to the code they test, run with [vitest](https://vitest.dev).

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please) and [Conventional Commits](https://www.conventionalcommits.org/):

1. Merge PRs to `main` with conventional commit messages: `feat:` → minor, `fix:` → patch, `feat!:` or `BREAKING CHANGE:` → major.
2. release-please opens or updates a **release PR** that bumps `package.json` and `CHANGELOG.md`.
3. Merging the release PR tags `vX.Y.Z`, creates the GitHub release and, **in the same workflow**, builds and pushes the multi-arch image to Docker Hub.

The workflow uses the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

**Prerequisite:** release-please opens its release PR with the workflow's `GITHUB_TOKEN`, so the repository must allow that. Enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**. Without it the release job fails with "GitHub Actions is not permitted to create or approve pull requests" and no release or image is ever published. The CLI equivalent is:

```sh
gh api -X PUT repos/<owner>/bravebot/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

(Alternative: pass a GitHub App token or PAT to `release-please-action` via `token:`. This also lets CI run on the release PR, since PRs opened by `GITHUB_TOKEN` do not trigger other workflows. It needs an extra secret.)

Dependabot keeps dependencies current:

- Runtime dependencies use the `fix(deps)` prefix, so merging one cuts a patch release. These are the npm production packages, yt-dlp in `docker/requirements.txt` and the Docker base image.
- Dev tooling and GitHub Actions use the `chore(deps)` prefix and don't trigger a release.

CI (`.github/workflows/ci.yaml`) runs typecheck, lint, tests, a TypeScript build and a multi-arch Docker build (no push) on every PR and on every push to `main`.
