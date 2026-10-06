/**
 * Dispatch every Interaction to its handler (INTERACTIONS implementer).
 * Must catch all errors: log to console, reply/followUp ephemerally with a generic
 * message if possible, and log an admin 'failure' (reason 'internal-error').
 * Ignore interactions outside guilds.
 */
import type { Interaction } from 'discord.js';
import { errorMessage } from '../errors.js';
import type { BotContext } from '../types.js';
import { handleAutocomplete } from './autocomplete.js';
import { COMMANDS, PLAY_CONTEXT_MENU_NAME } from './commands.js';
import { handlePlayContextMenu } from './contextMenu.js';
import { handleSkipCommand, handleStopCommand, handleVolumeCommand } from './controls.js';
import { handlePanelButton, handleSoundboardCommand, isPanelCustomId } from './panel.js';
import { handlePlayCommand } from './play.js';
import { logFailure, replyEphemeral, userRefOf } from './reply.js';
import { handleSoundCommand } from './sound.js';
import { MESSAGES } from './validation.js';

/** Short label of what was attempted, for the admin log. */
export function describeInteraction(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) {
    const sub = interaction.options.getSubcommand(false);
    return sub ? `/${interaction.commandName} ${sub}` : `/${interaction.commandName}`;
  }
  if (interaction.isMessageContextMenuCommand()) return 'context menu';
  if (interaction.isButton()) return 'panel button';
  if (interaction.isAutocomplete()) return 'autocomplete';
  return 'interaction';
}

async function dispatch(ctx: BotContext, interaction: Interaction<'cached'>): Promise<void> {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(ctx, interaction);
    return;
  }
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case COMMANDS.play:
        return handlePlayCommand(ctx, interaction);
      case COMMANDS.soundboard:
        return handleSoundboardCommand(ctx, interaction);
      case COMMANDS.stop:
        return handleStopCommand(ctx, interaction);
      case COMMANDS.skip:
        return handleSkipCommand(ctx, interaction);
      case COMMANDS.volume:
        return handleVolumeCommand(ctx, interaction);
      case COMMANDS.sound:
        return handleSoundCommand(ctx, interaction);
      default:
        await replyEphemeral(interaction, MESSAGES.unknownCommand);
        return;
    }
  }
  if (interaction.isMessageContextMenuCommand()) {
    if (interaction.commandName === PLAY_CONTEXT_MENU_NAME) {
      await handlePlayContextMenu(ctx, interaction);
    } else {
      await replyEphemeral(interaction, MESSAGES.unknownCommand);
    }
    return;
  }
  if (interaction.isButton() && isPanelCustomId(interaction.customId)) {
    await handlePanelButton(ctx, interaction);
  }
  // Anything else (other components, modals) is not ours: ignore.
}

export async function handleInteraction(ctx: BotContext, interaction: Interaction): Promise<void> {
  if (!interaction.inGuild()) return;
  if (!interaction.inCachedGuild()) {
    // Guild not in cache (should not happen with the Guilds intent): answer politely.
    try {
      if (interaction.isAutocomplete()) await interaction.respond([]);
      else if (interaction.isRepliable()) await replyEphemeral(interaction, MESSAGES.notReady);
    } catch (err) {
      console.error('[interaction] could not answer uncached-guild interaction:', err);
    }
    return;
  }

  try {
    await dispatch(ctx, interaction);
  } catch (err) {
    console.error(`[interaction] ${describeInteraction(interaction)} failed:`, err);
    logFailure(ctx, interaction.guildId, {
      reason: 'internal-error',
      action: describeInteraction(interaction),
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: errorMessage(err),
    });
    if (interaction.isRepliable()) {
      try {
        await replyEphemeral(interaction, MESSAGES.internalError);
      } catch (replyErr) {
        console.error('[interaction] could not send error reply:', replyErr);
      }
    }
  }
}
