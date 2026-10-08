/**
 * Autocomplete for sound options (INTERACTIONS implementer). Returns at most
 * AUTOCOMPLETE_LIMIT (25) choices: { name: sound.name, value: sound.id }. Must respond
 * within 3s and never throw (respond([]) on any problem, e.g. guild not ready).
 */
import type { AutocompleteInteraction } from 'discord.js';
import type { BotContext } from '../types.js';
import { OPTIONS } from './commands.js';
import { guildStateOf } from './reply.js';
import { autocompleteChoices } from './validation.js';

export async function handleAutocomplete(ctx: BotContext, interaction: AutocompleteInteraction<'cached'>): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    const state = guildStateOf(ctx, interaction.guildId);
    const choices =
      focused.name === OPTIONS.sound && state ? autocompleteChoices(state.library, String(focused.value)) : [];
    await interaction.respond(choices);
  } catch (err) {
    console.error('[autocomplete] failed:', err);
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => undefined);
    }
  }
}
