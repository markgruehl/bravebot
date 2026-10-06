/**
 * /sound add | rename | delete (INTERACTIONS implementer).
 * add: CreateGuildExpressions (Administrator implied); exactly one of attachment|url.
 * rename/delete: ManageGuildExpressions for any sound, or CreateGuildExpressions for sounds
 * the caller added (sound.addedBy === user id). Logs library-* / failure events.
 *
 * Expression permissions are guild-level, so checks use member.permissions (not the
 * permissions of the channel the command was typed in).
 */
import type { ChatInputCommandInteraction } from 'discord.js';
import { errorMessage, LibraryError } from '../errors.js';
import { nameKey, validateSoundName } from '../library/names.js';
import { isAudioAttachment, isHttpUrl } from '../playback/sources.js';
import type {
  AddSoundInput,
  AdminLogEvent,
  BotContext,
  FailureReason,
  GuildState,
  LibrarySound,
  SourceSummary,
  UserRef,
} from '../types.js';
import { OPTIONS, SOUND_SUBCOMMANDS } from './commands.js';
import { canAddSounds, canModifySound } from './permissions.js';
import { deferEphemeral, deny, guildStateOf, replyEphemeral, userRefOf } from './reply.js';
import { MESSAGES, bold, describeLibraryError, pickExactlyOne, resolveSoundOption } from './validation.js';

type SoundInteraction = ChatInputCommandInteraction<'cached'>;

interface SoundCommandContext {
  readonly ctx: BotContext;
  readonly interaction: SoundInteraction;
  readonly state: GuildState;
  readonly user: UserRef;
  readonly action: string;
}

export async function handleSoundCommand(ctx: BotContext, interaction: SoundInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);
  const action = `/sound ${subcommand}`;
  const user = userRefOf(interaction);
  const state = guildStateOf(ctx, interaction.guildId);
  if (!state) {
    await deny(ctx, interaction, MESSAGES.notReady, {
      reason: 'not-ready',
      action,
      user,
      voiceChannelId: null,
      source: null,
      detail: null,
    });
    return;
  }
  const sc: SoundCommandContext = { ctx, interaction, state, user, action };
  switch (subcommand) {
    case SOUND_SUBCOMMANDS.add:
      await handleAdd(sc);
      return;
    case SOUND_SUBCOMMANDS.rename:
      await handleRename(sc);
      return;
    case SOUND_SUBCOMMANDS.delete:
      await handleDelete(sc);
      return;
    default:
      await replyEphemeral(interaction, MESSAGES.unknownCommand);
  }
}

/** Loggable summary of a library sound (for failure entries). */
function soundSummary(sound: LibrarySound): SourceSummary {
  return {
    type: 'library',
    label: sound.name,
    url: sound.kind === 'link' ? sound.url : null,
    libraryName: sound.name,
  };
}

function logEvent(ctx: BotContext, guildId: string, event: AdminLogEvent): void {
  ctx.adminLog.log(guildId, event).catch((err: unknown) => console.error('[sound] admin log failed:', err));
}

async function denySimple(
  sc: SoundCommandContext,
  message: string,
  reason: FailureReason,
  extra: { source?: SourceSummary | null; detail?: string | null } = {},
): Promise<void> {
  await deny(sc.ctx, sc.interaction, message, {
    reason,
    action: sc.action,
    user: sc.user,
    voiceChannelId: null,
    source: extra.source ?? null,
    detail: extra.detail ?? null,
  });
}

/** Map a thrown error from the library store to a user reply + failure log. */
async function denyLibraryError(sc: SoundCommandContext, err: unknown, source: SourceSummary | null): Promise<void> {
  if (err instanceof LibraryError) {
    const { reason, message } = describeLibraryError(err);
    await denySimple(sc, message, reason, { source, detail: `${err.code}: ${err.message}` });
    return;
  }
  console.error(`[sound] ${sc.action} failed:`, err);
  await denySimple(sc, MESSAGES.internalError, 'internal-error', { source, detail: errorMessage(err) });
}

/** Look up the `sound` option (autocomplete id or typed name); denies when missing. */
async function requireSound(sc: SoundCommandContext): Promise<LibrarySound | null> {
  const value = sc.interaction.options.getString(OPTIONS.sound, true);
  const sound = resolveSoundOption(sc.state.library, value);
  if (!sound) {
    await denySimple(sc, MESSAGES.soundNotFound, 'sound-not-found', { detail: `requested: ${value}` });
    return null;
  }
  return sound;
}

function modifyDeniedMessage(verb: 'rename' | 'delete'): string {
  return (
    `You can only ${verb} sounds you added yourself (requires **Create Expressions**), ` +
    `or any sound with **Manage Expressions**.`
  );
}

async function handleAdd(sc: SoundCommandContext): Promise<void> {
  const { interaction, state } = sc;
  if (!canAddSounds(interaction.member.permissions)) {
    await denySimple(sc, MESSAGES.missingCreateExpressions, 'missing-permission', { detail: 'Create Expressions' });
    return;
  }

  const rawName = interaction.options.getString(OPTIONS.name, true);
  const validated = validateSoundName(rawName);
  if (!validated.ok) {
    await denySimple(sc, validated.error, 'invalid-name', { detail: `requested: ${rawName}` });
    return;
  }
  const name = validated.name;

  const attachment = interaction.options.getAttachment(OPTIONS.attachment);
  const url = interaction.options.getString(OPTIONS.url);
  const pick = pickExactlyOne({ attachment, url }, ['attachment', 'url'] as const);
  if (!pick.ok) {
    // Usage error; not an admin-log failure reason.
    await replyEphemeral(interaction, pick.error);
    return;
  }

  let input: AddSoundInput;
  let source: SourceSummary;
  if (pick.key === 'attachment' && attachment) {
    source = { type: 'attachment', label: attachment.name, url: attachment.url, libraryName: name };
    if (!isAudioAttachment({ contentType: attachment.contentType, filename: attachment.name })) {
      await denySimple(sc, MESSAGES.notAudioAttachment, 'bad-attachment', {
        source,
        detail: `content type: ${attachment.contentType ?? 'unknown'}`,
      });
      return;
    }
    input = {
      kind: 'file',
      name,
      addedBy: sc.user.id,
      attachmentUrl: attachment.url,
      filename: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
    };
  } else {
    const link = (url ?? '').trim();
    source = { type: 'url', label: link, url: link, libraryName: name };
    if (!isHttpUrl(link)) {
      await denySimple(sc, MESSAGES.invalidUrl, 'bad-url', { source });
      return;
    }
    input = { kind: 'link', name, addedBy: sc.user.id, url: link };
  }

  // Fast feedback; the store re-checks under its mutation lock.
  const existing = state.library.getByName(name);
  if (existing) {
    await denySimple(sc, `A sound named ${bold(existing.name)} already exists (names are case-insensitive).`, 'name-taken', {
      source,
    });
    return;
  }

  await deferEphemeral(interaction); // download + re-upload can be slow
  let sound: LibrarySound;
  try {
    sound = await state.library.add(input);
  } catch (err) {
    await denyLibraryError(sc, err, source);
    return;
  }
  logEvent(sc.ctx, interaction.guildId, { type: 'library-add', at: new Date(), user: sc.user, sound });
  await replyEphemeral(interaction, `Added ${bold(sound.name)} to the soundboard library.`);
}

async function handleRename(sc: SoundCommandContext): Promise<void> {
  const { interaction, state } = sc;
  const sound = await requireSound(sc);
  if (!sound) return;
  if (!canModifySound({ id: sc.user.id, permissions: interaction.member.permissions }, sound)) {
    await denySimple(sc, modifyDeniedMessage('rename'), 'missing-permission', {
      source: soundSummary(sound),
      detail: 'Manage Expressions (or Create Expressions for own sounds)',
    });
    return;
  }

  const rawName = interaction.options.getString(OPTIONS.name, true);
  const validated = validateSoundName(rawName);
  if (!validated.ok) {
    await denySimple(sc, validated.error, 'invalid-name', { source: soundSummary(sound), detail: `requested: ${rawName}` });
    return;
  }
  const newName = validated.name;
  const clash = state.library.getByName(newName);
  if (clash && clash.id !== sound.id) {
    await denySimple(sc, `A sound named ${bold(clash.name)} already exists (names are case-insensitive).`, 'name-taken', {
      source: soundSummary(sound),
    });
    return;
  }
  if (newName === sound.name) {
    await replyEphemeral(interaction, `${bold(sound.name)} already has that name.`);
    return;
  }

  await deferEphemeral(interaction);
  let updated: LibrarySound;
  try {
    updated = await state.library.rename(sound.id, newName);
  } catch (err) {
    await denyLibraryError(sc, err, soundSummary(sound));
    return;
  }
  logEvent(sc.ctx, interaction.guildId, {
    type: 'library-rename',
    at: new Date(),
    user: sc.user,
    sound: updated,
    oldName: sound.name,
  });
  const note = nameKey(sound.name) === nameKey(updated.name) ? ' (capitalization change)' : '';
  await replyEphemeral(interaction, `Renamed ${bold(sound.name)} to ${bold(updated.name)}${note}.`);
}

async function handleDelete(sc: SoundCommandContext): Promise<void> {
  const { interaction, state } = sc;
  const sound = await requireSound(sc);
  if (!sound) return;
  if (!canModifySound({ id: sc.user.id, permissions: interaction.member.permissions }, sound)) {
    await denySimple(sc, modifyDeniedMessage('delete'), 'missing-permission', {
      source: soundSummary(sound),
      detail: 'Manage Expressions (or Create Expressions for own sounds)',
    });
    return;
  }

  await deferEphemeral(interaction);
  let removed: LibrarySound;
  try {
    removed = await state.library.delete(sound.id);
  } catch (err) {
    await denyLibraryError(sc, err, soundSummary(sound));
    return;
  }
  logEvent(sc.ctx, interaction.guildId, { type: 'library-delete', at: new Date(), user: sc.user, sound: removed });
  await replyEphemeral(interaction, `Deleted ${bold(removed.name)} from the soundboard library.`);
}
