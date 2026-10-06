/**
 * Entry point: builds the BotContext and wires Discord events to modules.
 * Owned by SCAFFOLD (INTEGRATE may finalize). Keep logic out of here.
 */
import { Client, Events, GatewayIntentBits, Partials, type Guild } from 'discord.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { errorMessage, LibraryError } from './errors.js';
import { createAdminLog } from './guild/adminLog.js';
import { ensureChannels, ensureLogChannel } from './guild/setup.js';
import { createSetupCooldown } from './guild/setupRetry.js';
import { registerCommands } from './interactions/commands.js';
import { handleInteraction } from './interactions/router.js';
import { handlePingMessage } from './legacy/ping.js';
import { handleVoiceNotice } from './legacy/voiceNotices.js';
import { createLibraryStore } from './library/store.js';
import { createPlayerManager } from './playback/player.js';
import type { BotContext, GuildRegistry } from './types.js';

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Clear, single-line error for operators (no stack trace).
      console.error(`[config] ${err.message}. See .env.example.`);
      process.exit(1);
    }
    throw err;
  }
}

const config = loadConfigOrExit();

/**
 * REST timeout per request attempt. The @discordjs/rest default (15s) covers the whole
 * request including the body, which aborts library re-uploads of large files (up to 100 MiB
 * on boost tier 3) on ordinary uplinks. 3 minutes covers 100 MiB at roughly 5 Mbps.
 */
const REST_TIMEOUT_MS = 180_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
  ],
  // Library history is fetched with cache:false, so deletes of those messages arrive
  // uncached; without the Message partial discord.js would not emit messageDelete for them.
  partials: [Partials.Message],
  rest: { timeout: REST_TIMEOUT_MS },
});

const guilds: GuildRegistry = new Map();

const players = createPlayerManager({
  client,
  async freshAttachmentUrl(guildId, soundId) {
    const state = guilds.get(guildId);
    if (!state) throw new LibraryError('not-ready', 'Sound library is not ready for this server yet');
    return state.library.freshAttachmentUrl(soundId);
  },
});

const adminLog = createAdminLog((guildId) => guilds.get(guildId)?.channels.log);

const ctx: BotContext = { client, config, players, guilds, adminLog, ensureGuild };

// Player events -> admin log (play-time failures happen asynchronously).
players.on('trackError', ({ guildId, channelId, track, code, error }) => {
  void adminLog.log(guildId, {
    type: 'failure',
    at: new Date(),
    user: track.requester,
    reason: code === 'extraction-failed' ? 'extraction-failed' : 'playback-failed',
    action: 'track playback',
    voiceChannelId: channelId,
    source: track.source,
    detail: errorMessage(error),
  });
});

// ---------------------------------------------------------------------------
// Per-guild setup: channels + library index. Idempotent; concurrent calls share work.
// ---------------------------------------------------------------------------

const pendingSetups = new Map<string, Promise<void>>();
const setupCooldown = createSetupCooldown();

function initGuild(guild: Guild, attempt = 0): Promise<void> {
  const existing = pendingSetups.get(guild.id);
  if (existing) return existing;
  setupCooldown.mark(guild.id);
  let rerun = false;
  const run = (async () => {
    try {
      const channels = await ensureChannels(guild);
      const library = createLibraryStore(channels.library, client.user!.id);
      await library.load();
      // Setup takes a while (full history load). Events in that window are not applied to
      // a pending setup, so re-check before installing: discord.js drops deleted guilds and
      // channels from its caches when the delete events arrive.
      if (!client.guilds.cache.has(guild.id)) return; // the bot left the guild meanwhile
      if (!guild.channels.cache.has(channels.library.id) || !guild.channels.cache.has(channels.log.id)) {
        // A bot channel was deleted mid-setup: run setup again once (later retries go
        // through the rate-limited ensureGuild path).
        console.warn(`[setup] ${guild.name} (${guild.id}): a bot channel was deleted during setup`);
        rerun = attempt === 0;
        return;
      }
      guilds.set(guild.id, { channels, library });
      console.log(`[setup] ${guild.name} (${guild.id}): ${library.list().length} sound(s) loaded`);
    } catch (err) {
      console.error(`[setup] failed for guild ${guild.name} (${guild.id}):`, err);
    } finally {
      pendingSetups.delete(guild.id);
      if (rerun) void initGuild(guild, attempt + 1);
    }
  })();
  pendingSetups.set(guild.id, run);
  return run;
}

const pendingLogSetups = new Set<string>();

/**
 * Only the admin log channel was deleted: re-discover or re-create it and swap it in,
 * keeping the existing library store (no reload, so in-flight library changes and
 * MessageDelete handling are unaffected). Log writes in the meantime fail and are logged.
 * If no usable log channel can be set up (e.g. missing Manage Channels), fall back to the
 * normal not-ready + rate-limited setup retry, as when the log channel is missing at startup.
 */
async function replaceLogChannel(guild: Guild, deletedLogId: string): Promise<void> {
  if (pendingLogSetups.has(guild.id)) return;
  pendingLogSetups.add(guild.id);
  const stillStale = () => guilds.get(guild.id)?.channels.log.id === deletedLogId;
  try {
    const log = await ensureLogChannel(guild);
    const state = guilds.get(guild.id);
    if (!state || !stillStale()) return; // a full setup replaced or removed the state meanwhile
    if (!guild.channels.cache.has(log.id)) throw new Error(`#${log.name} was deleted while being set up`);
    guilds.set(guild.id, { ...state, channels: { ...state.channels, log } });
    console.log(`[setup] ${guild.name} (${guild.id}): admin log channel is now #${log.name}`);
  } catch (err) {
    console.error(`[setup] could not replace the admin log channel in ${guild.name} (${guild.id}):`, err);
    if (stillStale()) guilds.delete(guild.id);
  } finally {
    pendingLogSetups.delete(guild.id);
  }
}

/**
 * Lazy retry for a guild whose setup failed (transient Discord error, missing Manage
 * Channels, ...): called by interactions that find no GuildState. Fire-and-forget and
 * rate-limited per guild, so the interaction can answer within its 3s deadline.
 */
function ensureGuild(guildId: string): void {
  if (guilds.has(guildId) || pendingSetups.has(guildId)) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild?.available || !setupCooldown.due(guildId)) return;
  console.log(`[setup] retrying setup for guild ${guild.name} (${guild.id})`);
  void initGuild(guild);
}

// ---------------------------------------------------------------------------
// Discord events
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} (${readyClient.guilds.cache.size} guild(s))`);
  try {
    await registerCommands(readyClient);
    console.log('[commands] registered globally');
  } catch (err) {
    console.error('[commands] registration failed:', err);
  }
  // Unavailable guilds (outage at login) are set up when GuildAvailable fires.
  await Promise.allSettled(
    readyClient.guilds.cache.filter((guild) => guild.available).map((guild) => initGuild(guild)),
  );
});

client.on(Events.GuildCreate, (guild) => {
  void initGuild(guild);
});

// A guild that was unavailable (at login or after an outage) came back.
client.on(Events.GuildAvailable, (guild) => {
  if (!guilds.has(guild.id)) void initGuild(guild);
});

client.on(Events.GuildDelete, (guild) => {
  guilds.delete(guild.id);
  setupCooldown.forget(guild.id);
  players.destroyGuild(guild.id);
});

// One of our channels was deleted. Library channel: stop serving the stale index and re-run
// setup, which re-discovers a marked channel or creates a fresh private one and rebuilds the
// library. Log channel only: swap in a new log channel and keep the library store as is.
// (A delete during a still-pending setup is caught by initGuild's re-check.)
client.on(Events.ChannelDelete, (channel) => {
  if (channel.isDMBased()) return;
  const state = guilds.get(channel.guildId);
  if (!state) return;
  if (channel.id === state.channels.library.id) {
    guilds.delete(channel.guildId);
    void initGuild(channel.guild);
  } else if (channel.id === state.channels.log.id) {
    void replaceLogChannel(channel.guild, channel.id);
  }
});

// Library messages deleted by hand: drop those sounds from the index (frees their names).
client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;
  const state = guilds.get(message.guildId);
  if (state && message.channelId === state.channels.library.id) state.library.forget([message.id]);
});

client.on(Events.MessageBulkDelete, (messages, channel) => {
  const state = guilds.get(channel.guildId);
  if (state && channel.id === state.channels.library.id) state.library.forget(messages.keys());
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(ctx, interaction).catch((err: unknown) => {
    console.error('[interaction] unhandled error:', err);
  });
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    players.handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('[voice] player bookkeeping failed:', err);
  }
  handleVoiceNotice(ctx, oldState, newState).catch((err: unknown) => {
    console.error('[voice] notice failed:', err);
  });
});

client.on(Events.MessageCreate, (message) => {
  handlePingMessage(message).catch((err: unknown) => {
    console.error('[ping] failed:', err);
  });
});

client.on(Events.Error, (err) => {
  console.error('[client] error:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[process] ${signal} received, shutting down`);
  try {
    players.destroyAll();
  } catch (err) {
    console.error('[process] player teardown failed:', err);
  }
  // Never hang on shutdown: force exit if the gateway teardown stalls.
  setTimeout(() => process.exit(0), 5_000).unref();
  try {
    await client.destroy();
  } catch (err) {
    console.error('[process] client teardown failed:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await client.login(config.discordToken);
} catch (err) {
  console.error(`[client] login failed: ${errorMessage(err)}`);
  players.destroyAll();
  await client.destroy();
  process.exit(1);
}
