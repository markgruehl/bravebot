import { ButtonStyle, ComponentType, type APIButtonComponentWithCustomId } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { LibrarySound } from '../types.js';
import {
  MULTI_PAGE_CAPACITY,
  PANEL_CUSTOM_ID_PREFIX,
  SINGLE_PAGE_CAPACITY,
  buildPanelPage,
  isPanelCustomId,
  pageCustomId,
  panelPageCount,
  parsePanelCustomId,
  playCustomId,
} from './panel.js';

const sounds = (n: number): LibrarySound[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'file' as const,
    id: String(100000000000000000n + BigInt(i)),
    guildId: 'g',
    name: `s${String(i).padStart(3, '0')}`,
    addedBy: 'u',
    addedAt: new Date(0),
    filename: 'f.mp3',
  }));

const buttons = (page: ReturnType<typeof buildPanelPage>) =>
  page.components.flatMap((row) => row.components as APIButtonComponentWithCustomId[]);
const soundButtons = (page: ReturnType<typeof buildPanelPage>) =>
  buttons(page).filter((b) => b.custom_id.startsWith('sb:play:'));

describe('custom ids', () => {
  it('uses the sb: prefix', () => {
    expect(PANEL_CUSTOM_ID_PREFIX).toBe('sb:');
    expect(isPanelCustomId('sb:play:1')).toBe(true);
    expect(isPanelCustomId('other:play:1')).toBe(false);
  });
  it('round-trips play and page ids', () => {
    const id = '123456789012345678';
    expect(parsePanelCustomId(playCustomId(id))).toEqual({ action: 'play', soundId: id });
    expect(parsePanelCustomId(pageCustomId(7))).toEqual({ action: 'page', page: 7 });
    expect(parsePanelCustomId('sb:noop:2')).toEqual({ action: 'noop' });
  });
  it('rejects malformed ids', () => {
    for (const bad of ['sb:', 'sb:play', 'sb:play:', 'sb:play:abc', 'sb:page:-1', 'sb:page:x', 'sb:wat:1', 'nope', `sb:play:${'1'.repeat(200)}`]) {
      expect(parsePanelCustomId(bad), bad).toBeNull();
    }
  });
  it('keeps custom ids within 100 chars', () => {
    expect(playCustomId('9'.repeat(20)).length).toBeLessThanOrEqual(100);
  });
});

describe('panelPageCount', () => {
  it('uses one page up to 25 sounds, then 20 per page', () => {
    expect(panelPageCount(0)).toBe(1);
    expect(panelPageCount(1)).toBe(1);
    expect(panelPageCount(SINGLE_PAGE_CAPACITY)).toBe(1);
    expect(panelPageCount(26)).toBe(2);
    expect(panelPageCount(40)).toBe(2);
    expect(panelPageCount(41)).toBe(3);
  });
  it('capacities match Discord limits', () => {
    expect(SINGLE_PAGE_CAPACITY).toBe(25);
    expect(MULTI_PAGE_CAPACITY).toBe(20);
  });
});

describe('buildPanelPage', () => {
  it('renders an empty library message without components', () => {
    const p = buildPanelPage([], 0);
    expect(p.components).toEqual([]);
    expect(p.content).toContain('/sound add');
    expect(p.pageCount).toBe(1);
  });

  it('fits 25 sounds on one page with no nav row', () => {
    const p = buildPanelPage(sounds(25), 0);
    expect(p.pageCount).toBe(1);
    expect(p.components).toHaveLength(5);
    expect(soundButtons(p)).toHaveLength(25);
    expect(buttons(p).every((b) => b.custom_id.startsWith('sb:play:'))).toBe(true);
  });

  it('partially fills rows', () => {
    const p = buildPanelPage(sounds(7), 0);
    expect(p.components.map((r) => r.components.length)).toEqual([5, 2]);
  });

  it('paginates 20 per page with a nav row when over 25', () => {
    const all = sounds(45);
    const first = buildPanelPage(all, 0);
    expect(first.pageCount).toBe(3);
    expect(first.components).toHaveLength(5);
    expect(soundButtons(first)).toHaveLength(20);
    const nav = first.components[4]!.components as APIButtonComponentWithCustomId[];
    expect(nav.map((b) => b.label)).toEqual(['Previous', 'Page 1/3', 'Next']);
    expect(nav[0]!.disabled).toBe(true);
    expect(nav[1]!.disabled).toBe(true);
    expect(nav[2]!.disabled).toBe(false);
    expect(parsePanelCustomId(nav[2]!.custom_id)).toEqual({ action: 'page', page: 1 });

    const last = buildPanelPage(all, 2);
    expect(soundButtons(last)).toHaveLength(5);
    expect(soundButtons(last)[0]!.label).toBe('s040');
    const lastNav = last.components[last.components.length - 1]!.components as APIButtonComponentWithCustomId[];
    expect(lastNav[0]!.disabled).toBe(false);
    expect(parsePanelCustomId(lastNav[0]!.custom_id)).toEqual({ action: 'page', page: 1 });
    expect(lastNav[2]!.disabled).toBe(true);
  });

  it('every page shows each sound exactly once across pages', () => {
    const all = sounds(61);
    const seen = new Set<string>();
    const count = buildPanelPage(all, 0).pageCount;
    for (let i = 0; i < count; i++) for (const b of soundButtons(buildPanelPage(all, i))) seen.add(b.custom_id);
    expect(seen.size).toBe(61);
  });

  it('clamps out-of-range pages', () => {
    const all = sounds(30);
    expect(buildPanelPage(all, 99).page).toBe(1);
    expect(buildPanelPage(all, -3).page).toBe(0);
    expect(buildPanelPage(all, Number.NaN).page).toBe(0);
  });

  it('never exceeds 5 rows x 5 buttons and custom ids are unique per message', () => {
    for (const n of [1, 5, 24, 25, 26, 40, 41, 100, 101]) {
      const total = panelPageCount(n);
      for (let page = 0; page < total; page++) {
        const p = buildPanelPage(sounds(n), page);
        expect(p.components.length).toBeLessThanOrEqual(5);
        for (const row of p.components) {
          expect(row.type).toBe(ComponentType.ActionRow);
          expect(row.components.length).toBeLessThanOrEqual(5);
        }
        const ids = buttons(p).map((b) => b.custom_id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.length <= 100)).toBe(true);
      }
    }
  });

  it('labels buttons with the sound name', () => {
    const p = buildPanelPage(sounds(2), 0);
    expect(soundButtons(p).map((b) => b.label)).toEqual(['s000', 's001']);
    expect(soundButtons(p)[0]!.style).toBe(ButtonStyle.Secondary);
  });
});
