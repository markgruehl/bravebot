/**
 * /soundboard ephemeral button panel (INTERACTIONS implementer).
 * Discord allows 5 action rows x 5 buttons. When the library needs more than one page,
 * reserve one row for navigation (prev / page indicator / next), i.e. up to 20 sound
 * buttons per page; a single page may use all 25. Clicking a sound button plays it with
 * DEFAULT_PLAY_MODE and VOLUME_DEFAULT via executePlay(..., via: 'panel').
 *
 * Custom ids (all <= 100 chars):
 *   sb:play:<soundId>   play a library sound (soundId = library message id)
 *   sb:page:<n>         show page n (0-based); prev/next always target different pages
 *   sb:noop:<n>         disabled "Page x/y" indicator (never actually clickable)
 */
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { DEFAULT_PLAY_MODE, MAX_ACTION_ROWS, MAX_BUTTONS_PER_ROW, VOLUME_DEFAULT } from '../constants.js';
import type { BotContext, LibrarySound } from '../types.js';
import { executePlay } from './play.js';
import { deny, guildStateOf, replyEphemeral, userRefOf } from './reply.js';
import { MESSAGES, truncate } from './validation.js';

/** All panel custom ids start with this prefix (e.g. "sb:play:<soundId>", "sb:page:<n>"). */
export const PANEL_CUSTOM_ID_PREFIX = 'sb:';

/** Sound buttons on a single-page panel (all 25 slots). */
export const SINGLE_PAGE_CAPACITY = MAX_ACTION_ROWS * MAX_BUTTONS_PER_ROW;
/** Sound buttons per page when paginated (one row reserved for navigation). */
export const MULTI_PAGE_CAPACITY = (MAX_ACTION_ROWS - 1) * MAX_BUTTONS_PER_ROW;

/** Discord limits. */
const CUSTOM_ID_MAX_LENGTH = 100;
const BUTTON_LABEL_MAX_LENGTH = 80;

export function isPanelCustomId(customId: string): boolean {
  return customId.startsWith(PANEL_CUSTOM_ID_PREFIX);
}

export type PanelAction =
  | { readonly action: 'play'; readonly soundId: string }
  | { readonly action: 'page'; readonly page: number }
  | { readonly action: 'noop' };

export function playCustomId(soundId: string): string {
  return `${PANEL_CUSTOM_ID_PREFIX}play:${soundId}`;
}

export function pageCustomId(page: number): string {
  return `${PANEL_CUSTOM_ID_PREFIX}page:${page}`;
}

function noopCustomId(page: number): string {
  return `${PANEL_CUSTOM_ID_PREFIX}noop:${page}`;
}

/** Parse a panel custom id; null for anything malformed or unknown. */
export function parsePanelCustomId(customId: string): PanelAction | null {
  if (!isPanelCustomId(customId) || customId.length > CUSTOM_ID_MAX_LENGTH) return null;
  const rest = customId.slice(PANEL_CUSTOM_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  const kind = rest.slice(0, sep);
  const arg = rest.slice(sep + 1);
  switch (kind) {
    case 'play':
      return /^\d{1,25}$/.test(arg) ? { action: 'play', soundId: arg } : null;
    case 'page':
      return /^\d{1,6}$/.test(arg) ? { action: 'page', page: Number(arg) } : null;
    case 'noop':
      return { action: 'noop' };
    default:
      return null;
  }
}

/** Number of pages for `count` sounds (always >= 1). */
export function panelPageCount(count: number): number {
  if (count <= SINGLE_PAGE_CAPACITY) return 1;
  return Math.ceil(count / MULTI_PAGE_CAPACITY);
}

export interface PanelPage {
  readonly content: string;
  readonly components: APIActionRowComponent<APIComponentInMessageActionRow>[];
  /** 0-based page actually rendered (clamped). */
  readonly page: number;
  readonly pageCount: number;
}

function button(customId: string, label: string, style: ButtonStyle, disabled = false): APIButtonComponentWithCustomId {
  return {
    type: ComponentType.Button,
    style: style as APIButtonComponentWithCustomId['style'],
    custom_id: customId,
    label: truncate(label, BUTTON_LABEL_MAX_LENGTH),
    disabled,
  };
}

function row(components: APIButtonComponentWithCustomId[]): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components };
}

/** Pure: render a page of the panel. */
export function buildPanelPage(sounds: readonly LibrarySound[], page: number): PanelPage {
  if (sounds.length === 0) {
    return {
      content: 'The soundboard library is empty. Add sounds with `/sound add`.',
      components: [],
      page: 0,
      pageCount: 1,
    };
  }

  const pageCount = panelPageCount(sounds.length);
  const safePage = Number.isFinite(page) ? Math.min(Math.max(Math.trunc(page), 0), pageCount - 1) : 0;
  const perPage = pageCount === 1 ? SINGLE_PAGE_CAPACITY : MULTI_PAGE_CAPACITY;
  const pageSounds = sounds.slice(safePage * perPage, (safePage + 1) * perPage);

  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  for (let i = 0; i < pageSounds.length; i += MAX_BUTTONS_PER_ROW) {
    components.push(
      row(
        pageSounds
          .slice(i, i + MAX_BUTTONS_PER_ROW)
          .map((sound) => button(playCustomId(sound.id), sound.name, ButtonStyle.Secondary)),
      ),
    );
  }

  if (pageCount > 1) {
    // prev/next targets differ whenever pageCount > 1, so custom ids stay unique.
    components.push(
      row([
        button(pageCustomId(Math.max(safePage - 1, 0)), 'Previous', ButtonStyle.Primary, safePage === 0),
        button(noopCustomId(safePage), `Page ${safePage + 1}/${pageCount}`, ButtonStyle.Secondary, true),
        button(pageCustomId(Math.min(safePage + 1, pageCount - 1)), 'Next', ButtonStyle.Primary, safePage === pageCount - 1),
      ]),
    );
  }

  const countText = sounds.length === 1 ? '1 sound' : `${sounds.length} sounds`;
  const pageText = pageCount > 1 ? `, page ${safePage + 1}/${pageCount}` : '';
  return {
    content: `**Soundboard** (${countText}${pageText}). Click a sound to play it in your voice channel.`,
    components,
    page: safePage,
    pageCount,
  };
}

export async function handleSoundboardCommand(ctx: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const state = guildStateOf(ctx, interaction.guildId);
  if (!state) {
    await deny(ctx, interaction, MESSAGES.notReady, {
      reason: 'not-ready',
      action: '/soundboard',
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: null,
    });
    return;
  }
  const panel = buildPanelPage(state.library.list(), 0);
  await interaction.reply({
    content: panel.content,
    components: panel.components,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handlePanelButton(ctx: BotContext, interaction: ButtonInteraction<'cached'>): Promise<void> {
  const parsed = parsePanelCustomId(interaction.customId);
  if (!parsed) {
    await replyEphemeral(interaction, MESSAGES.staleButton);
    return;
  }
  if (parsed.action === 'noop') {
    await interaction.deferUpdate();
    return;
  }

  const state = guildStateOf(ctx, interaction.guildId);
  if (!state) {
    await deny(ctx, interaction, MESSAGES.notReady, {
      reason: 'not-ready',
      action: 'panel button',
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: null,
    });
    return;
  }

  if (parsed.action === 'page') {
    const panel = buildPanelPage(state.library.list(), parsed.page);
    await interaction.update({ content: panel.content, components: panel.components, allowedMentions: { parse: [] } });
    return;
  }

  const sound = state.library.getById(parsed.soundId);
  if (!sound) {
    await deny(ctx, interaction, MESSAGES.panelSoundGone, {
      reason: 'sound-not-found',
      action: 'panel button',
      user: userRefOf(interaction),
      voiceChannelId: interaction.member.voice.channelId,
      source: null,
      detail: `sound id ${parsed.soundId}`,
    });
    return;
  }
  // A new ephemeral reply per click keeps the panel itself intact for further clicks.
  await executePlay(ctx, interaction, {
    source: { type: 'library', sound },
    mode: DEFAULT_PLAY_MODE,
    volume: VOLUME_DEFAULT,
    via: 'panel',
  });
}
