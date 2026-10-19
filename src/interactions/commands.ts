/**
 * Command definitions + global registration (INTERACTIONS implementer).
 * All commands are guild-only (contexts: [InteractionContextType.Guild]); permissions
 * are enforced at runtime, not via default_member_permissions.
 *
 * Sound options (play.sound, sound rename/delete .sound) use autocomplete; the choice
 * VALUE is the sound id (library message id). Handlers must accept either an id or a
 * typed name: library.getById(v) ?? library.getByName(v).
 */
import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  type Client,
  type RESTPostAPIApplicationCommandsJSONBody,
  type SlashCommandIntegerOption,
} from 'discord.js';
import {
  SOUND_NAME_MAX_LENGTH,
  SOUND_NAME_MIN_LENGTH,
  STATS_DAYS_DEFAULT,
  STATS_DAYS_MAX,
  STATS_DAYS_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
} from '../constants.js';

export const COMMANDS = {
  play: 'play',
  soundboard: 'soundboard',
  stop: 'stop',
  skip: 'skip',
  volume: 'volume',
  sound: 'sound',
  stats: 'stats',
  info: 'info',
} as const;

export const SOUND_SUBCOMMANDS = { add: 'add', rename: 'rename', delete: 'delete' } as const;

export const STATS_SUBCOMMANDS = { server: 'server', user: 'user', channel: 'channel' } as const;

/** Message context-menu command name (exact). */
export const PLAY_CONTEXT_MENU_NAME = 'Play in my voice channel';

export const OPTIONS = {
  attachment: 'attachment',
  url: 'url',
  sound: 'sound',
  mode: 'mode',
  volume: 'volume',
  /** /sound add + /sound rename: the (new) name. */
  name: 'name',
  /** /volume: the new level (integer 0-200). */
  level: 'level',
  /** /stats: window length in days (integer 1-365, default 30). */
  days: 'days',
  /** /stats user: whose card (default: the caller). */
  user: 'user',
  /** /stats channel: the voice channel. */
  channel: 'channel',
} as const;

/** Applies guild-only availability (no DMs, no user installs). */
function guildOnly<T extends SlashCommandBuilder | ContextMenuCommandBuilder>(builder: T): T {
  builder.setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  return builder;
}

/** The optional /stats `days` option, shared by every subcommand. */
function daysOption(o: SlashCommandIntegerOption): SlashCommandIntegerOption {
  return o
    .setName(OPTIONS.days)
    .setDescription(`How many days back to look (${STATS_DAYS_MIN}-${STATS_DAYS_MAX}, default ${STATS_DAYS_DEFAULT})`)
    .setMinValue(STATS_DAYS_MIN)
    .setMaxValue(STATS_DAYS_MAX);
}

export function buildCommandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const play = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.play)
    .setDescription('Play audio in your voice channel (give exactly one of attachment, url or sound)')
    .addAttachmentOption((o) => o.setName(OPTIONS.attachment).setDescription('An audio file to play once'))
    .addStringOption((o) =>
      o.setName(OPTIONS.url).setDescription('A link: direct audio, YouTube, SoundCloud, playlists and more'),
    )
    .addStringOption((o) =>
      o.setName(OPTIONS.sound).setDescription('A saved sound from the library').setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName(OPTIONS.mode)
        .setDescription('Interrupt what is playing (default) or add to the queue')
        .addChoices({ name: 'interrupt (default)', value: 'interrupt' }, { name: 'queue', value: 'queue' }),
    )
    .addIntegerOption((o) =>
      o
        .setName(OPTIONS.volume)
        .setDescription(`Volume percent (${VOLUME_MIN}-${VOLUME_MAX}, default 100)`)
        .setMinValue(VOLUME_MIN)
        .setMaxValue(VOLUME_MAX),
    );

  const soundboard = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.soundboard)
    .setDescription('Show a private button panel of the saved sounds');

  const stop = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.stop)
    .setDescription('Stop playback and clear the queue');

  const skip = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.skip)
    .setDescription('Skip to the next queued item');

  const volume = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.volume)
    .setDescription('Change the volume of what is playing now')
    .addIntegerOption((o) =>
      o
        .setName(OPTIONS.level)
        .setDescription(`Volume percent (${VOLUME_MIN}-${VOLUME_MAX})`)
        .setMinValue(VOLUME_MIN)
        .setMaxValue(VOLUME_MAX)
        .setRequired(true),
    );

  const sound = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.sound)
    .setDescription('Manage the saved sound library')
    .addSubcommand((sc) =>
      sc
        .setName(SOUND_SUBCOMMANDS.add)
        .setDescription('Save a sound (give exactly one of attachment or url)')
        .addStringOption((o) =>
          o
            .setName(OPTIONS.name)
            .setDescription(`Unique name (${SOUND_NAME_MIN_LENGTH}-${SOUND_NAME_MAX_LENGTH} characters)`)
            .setMinLength(SOUND_NAME_MIN_LENGTH)
            .setMaxLength(SOUND_NAME_MAX_LENGTH)
            .setRequired(true),
        )
        .addAttachmentOption((o) => o.setName(OPTIONS.attachment).setDescription('An audio file to save'))
        .addStringOption((o) =>
          o.setName(OPTIONS.url).setDescription('A link to save (resolved fresh every time it plays)'),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName(SOUND_SUBCOMMANDS.rename)
        .setDescription('Rename a saved sound')
        .addStringOption((o) =>
          o.setName(OPTIONS.sound).setDescription('The sound to rename').setAutocomplete(true).setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName(OPTIONS.name)
            .setDescription(`New name (${SOUND_NAME_MIN_LENGTH}-${SOUND_NAME_MAX_LENGTH} characters)`)
            .setMinLength(SOUND_NAME_MIN_LENGTH)
            .setMaxLength(SOUND_NAME_MAX_LENGTH)
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName(SOUND_SUBCOMMANDS.delete)
        .setDescription('Delete a saved sound')
        .addStringOption((o) =>
          o.setName(OPTIONS.sound).setDescription('The sound to delete').setAutocomplete(true).setRequired(true),
        ),
    );

  const stats = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.stats)
    .setDescription('Voice channel stats from the join/leave notices')
    .addSubcommand((sc) =>
      sc.setName(STATS_SUBCOMMANDS.server).setDescription('Stats for the whole server').addIntegerOption(daysOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName(STATS_SUBCOMMANDS.user)
        .setDescription("Someone's voice stats card")
        .addUserOption((o) => o.setName(OPTIONS.user).setDescription('Whose stats (default: you)'))
        .addIntegerOption(daysOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName(STATS_SUBCOMMANDS.channel)
        .setDescription('Stats for one voice channel')
        .addChannelOption((o) =>
          o
            .setName(OPTIONS.channel)
            .setDescription('The voice channel')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true),
        )
        .addIntegerOption(daysOption),
    );

  const info = guildOnly(new SlashCommandBuilder())
    .setName(COMMANDS.info)
    .setDescription('About this bot: version, uptime and features');

  const contextMenu = guildOnly(new ContextMenuCommandBuilder())
    .setName(PLAY_CONTEXT_MENU_NAME)
    .setType(ApplicationCommandType.Message);

  return [
    play.toJSON(),
    soundboard.toJSON(),
    stop.toJSON(),
    skip.toJSON(),
    volume.toJSON(),
    sound.toJSON(),
    stats.toJSON(),
    info.toJSON(),
    contextMenu.toJSON(),
  ];
}

/** Registers globally via client.application.commands.set(buildCommandDefinitions()). */
export async function registerCommands(client: Client<true>): Promise<void> {
  await client.application.commands.set(buildCommandDefinitions());
}
