import { Collection } from 'discord.js';
import type { Client, Guild } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsError } from '../errors.js';
import { coverageStart, createStatsService } from './cache.js';
import { DAY_MS, HOUR_MS } from './time.js';
import type { NoticeMessage } from './types.js';

const BOT = '100000000000000001';
const GUILD = '400000000000000004';
const SYS = '500000000000000005';
const SYS2 = '500000000000000006';
const VC = '600000000000000006';
const VC2 = '600000000000000007';
const U1 = '700000000000000001';
const U2 = '700000000000000002';
const U3 = '700000000000000003';
const NOW = Date.UTC(2026, 9, 8, 12);

interface FakeMessage extends NoticeMessage {
  channelId: string;
}

interface FakeMember {
  id: string;
  displayName: string;
  user: { username: string; bot: boolean };
}

function apiError(code: number): Error {
  return Object.assign(new Error(`Discord error ${code}`), { code, status: 403 });
}

function world() {
  let nextId = 800000000000000000n;
  const history = new Map<string, FakeMessage[]>(); // per channel, ascending by id
  let gate: Promise<void> | null = null;
  let failure: unknown = null;
  let allowed = true;

  function post(channelId: string, content: string, at: number, authorId = BOT): FakeMessage {
    const message: FakeMessage = { id: String(nextId++), channelId, content, createdTimestamp: at, author: { id: authorId } };
    const list = history.get(channelId) ?? [];
    list.push(message);
    history.set(channelId, list);
    return message;
  }

  function makeChannel(id: string) {
    const fetch = vi.fn(async (arg: { limit?: number; before?: string; cache?: boolean }) => {
      if (gate) await gate;
      if (failure) throw failure;
      const limit = arg.limit ?? 50;
      const older = (history.get(id) ?? []).filter((m) => arg.before === undefined || BigInt(m.id) < BigInt(arg.before));
      const page = older.slice(-limit).reverse(); // newest first, like Discord
      return new Collection(page.map((m) => [m.id, m]));
    });
    return {
      id,
      name: `chan-${id.slice(-1)}`,
      permissionsFor: vi.fn(() => ({ has: () => allowed })),
      messages: { fetch },
    };
  }

  const channels = { [SYS]: makeChannel(SYS), [SYS2]: makeChannel(SYS2) };
  const members = new Map<string, FakeMember>();
  const users = new Map<string, { username: string; globalName?: string; bot: boolean }>();

  const membersFetch = vi.fn(async (arg: string | { user: string[] }) => {
    if (typeof arg === 'string') {
      const member = members.get(arg);
      if (!member) throw apiError(10007);
      return member;
    }
    const found = arg.user.flatMap((id) => {
      const member = members.get(id);
      return member ? [[id, member] as const] : [];
    });
    return new Collection(found);
  });

  const voiceStates = new Collection<string, { id: string; channelId: string | null; member: FakeMember | null }>();

  const guild = {
    id: GUILD,
    name: 'Friends',
    systemChannel: channels[SYS] as ReturnType<typeof makeChannel> | null,
    members: {
      me: { id: BOT } as { id: string } | null,
      fetchMe: vi.fn(async () => {
        throw new Error('gateway down');
      }),
      fetch: membersFetch,
    },
    voiceStates: { cache: voiceStates },
  };

  const client = {
    user: { id: BOT },
    users: {
      fetch: vi.fn(async (id: string) => {
        const user = users.get(id);
        if (!user) throw apiError(10013);
        return { ...user, displayName: user.globalName ?? user.username }; // like discord.js User#displayName
      }),
    },
  };

  let release: () => void = () => undefined;
  return {
    guild: guild as unknown as Guild,
    raw: guild,
    client: client as unknown as Client,
    rawClient: client,
    channels,
    members,
    users,
    voiceStates,
    post,
    connect: (userId: string, at: number, channelId = SYS, voice = VC) =>
      post(channelId, `<@${userId}> has connected to <#${voice}>`, at),
    disconnect: (userId: string, at: number, channelId = SYS, voice = VC) =>
      post(channelId, `<@${userId}> has disconnected from <#${voice}>`, at),
    hold() {
      gate = new Promise((resolve) => (release = resolve));
    },
    release() {
      gate = null;
      release();
    },
    fail(err: unknown) {
      failure = err;
    },
    deny() {
      allowed = false;
    },
    member(id: string, displayName: string, username: string, bot = false) {
      members.set(id, { id, displayName, user: { username, bot } });
    },
  };
}

/** A message the fake world did not store (as if the bot just posted it). */
function liveNotice(id: string, content: string, at: number, channelId = SYS, authorId = BOT): NoticeMessage {
  return { id, channelId, content, createdTimestamp: at, author: { id: authorId } };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('load', () => {
  it('pages newest to oldest and stops at the horizon', async () => {
    const w = world();
    for (let i = 300; i > 0; i--) w.connect(U1, NOW - 20 * DAY_MS - i * HOUR_MS); // beyond a 10-day horizon
    for (let i = 150; i > 0; i--) w.connect(U2, NOW - i * HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW, cacheDays: 10 });

    const history = await stats.load(w.guild);

    const fetch = w.channels[SYS].messages.fetch;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toEqual({ limit: 100, cache: false });
    const firstPage = (await fetch.mock.results[0]!.value) as Collection<string, FakeMessage>;
    const oldestOfFirst = [...firstPage.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    expect(fetch.mock.calls[1]![0]).toEqual({ limit: 100, cache: false, before: oldestOfFirst });

    expect(history.channelId).toBe(SYS);
    expect(history.events).toHaveLength(150);
    expect(history.events.every((e) => e.userId === U2)).toBe(true);
    // Older messages exist, so the history covers the whole horizon (not just from its oldest notice).
    expect(history.oldestEventAt).toBe(NOW - 10 * DAY_MS);
    expect(history.events.map((e) => e.at)).toEqual([...history.events.map((e) => e.at)].sort((a, b) => a - b));
    expect(stats.status(GUILD)).toEqual({ events: 150, oldestEventAt: NOW - 150 * HOUR_MS, building: false });
  });

  it('stops on a short page and reads the whole history', async () => {
    const w = world();
    for (let i = 0; i < 30; i++) w.connect(U1, NOW - (30 - i) * HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    const history = await stats.load(w.guild);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(1);
    expect(history.events).toHaveLength(30);
    expect(history.oldestEventAt).toBe(NOW - 30 * HOUR_MS);
  });

  it('starts coverage at the first notice when only older non-notice chat reaches the horizon', async () => {
    const w = world();
    for (let i = 0; i < 150; i++) w.post(SYS, 'hello', NOW - 60 * DAY_MS + i * HOUR_MS, U2); // old chat
    w.connect(U1, NOW - 20 * DAY_MS);
    w.disconnect(U1, NOW - 20 * DAY_MS + HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW, cacheDays: 30 });
    const history = await stats.load(w.guild);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(1); // the first page already passes the horizon
    expect(history.events).toHaveLength(2);
    expect(history.oldestEventAt).toBe(NOW - 20 * DAY_MS);
  });

  it('covers the whole horizon when notices run right up to it', async () => {
    const w = world();
    for (let i = 150; i > 0; i--) w.connect(U1, NOW - 10 * DAY_MS + 12 * HOUR_MS + 30 * 60_000 - i * HOUR_MS); // straddles the cutoff
    for (let i = 5; i > 0; i--) w.connect(U2, NOW - i * DAY_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW, cacheDays: 10 });
    const history = await stats.load(w.guild);
    expect(history.events[0]!.at).toBeGreaterThan(NOW - 10 * DAY_MS);
    expect(history.oldestEventAt).toBe(NOW - 10 * DAY_MS);
  });

  it('reports no coverage without notices, even when the channel is old', async () => {
    const w = world();
    for (let i = 0; i < 150; i++) w.post(SYS, 'hello', NOW - 60 * DAY_MS + i * HOUR_MS, U2);
    w.post(SYS, 'Welcome!', NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW, cacheDays: 30 });
    const history = await stats.load(w.guild);
    expect(history.events).toEqual([]);
    expect(history.oldestEventAt).toBeNull();
  });

  it('keeps only voice notices the bot wrote', async () => {
    const w = world();
    w.connect(U1, NOW - 3 * HOUR_MS);
    w.post(SYS, `<@${U2}> has connected to <#${VC}>`, NOW - 2 * HOUR_MS, U2); // a user faking a notice
    w.post(SYS, 'Welcome to the server!', NOW - HOUR_MS); // bot, not a notice
    w.post(SYS, `<@${U2}> has changed channels from <#${VC}> to <#${VC2}>`, NOW - 30 * 60_000);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    const history = await stats.load(w.guild);
    expect(history.events.map((e) => [e.kind, e.userId])).toEqual([
      ['connect', U1],
      ['move', U2],
    ]);
  });

  it('shares one scan between concurrent callers and then serves the cache', async () => {
    const w = world();
    w.connect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    const a = stats.load(w.guild);
    const b = stats.load(w.guild);
    await flush();
    expect(stats.status(GUILD)).toEqual({ events: 0, oldestEventAt: null, building: true });
    w.release();
    const [ha, hb] = await Promise.all([a, b]);
    expect(ha.events).toHaveLength(1);
    expect(hb).toEqual(ha);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(1);

    await stats.load(w.guild);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects without a system channel', async () => {
    const w = world();
    w.raw.systemChannel = null;
    const stats = createStatsService({ client: w.client, now: () => NOW });
    await expect(stats.load(w.guild)).rejects.toMatchObject({ name: 'StatsError', code: 'no-system-channel' });
    expect(stats.status(GUILD)).toBeNull();
  });

  it('rejects with missing-access when the bot cannot read the channel', async () => {
    const w = world();
    w.deny();
    const stats = createStatsService({ client: w.client, now: () => NOW });
    const err = await stats.load(w.guild).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatsError);
    expect(err).toMatchObject({ code: 'missing-access' });
    expect((err as Error).message).toContain(`<#${SYS}>`);
    expect(w.channels[SYS].messages.fetch).not.toHaveBeenCalled();
    expect(stats.status(GUILD)).toBeNull();
  });

  it('lets the API decide when its own member cannot be resolved', async () => {
    const w = world();
    w.raw.members.me = null;
    w.connect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    const history = await stats.load(w.guild);
    expect(w.raw.members.fetchMe).toHaveBeenCalled();
    expect(history.events).toHaveLength(1);
  });

  it.each([50001, 50013, 10003])('maps Discord error %i to missing-access', async (code) => {
    const w = world();
    w.fail(apiError(code));
    const stats = createStatsService({ client: w.client, now: () => NOW });
    await expect(stats.load(w.guild)).rejects.toMatchObject({ code: 'missing-access' });
  });

  it('caches nothing on failure, rejects every waiter, and retries next time', async () => {
    const w = world();
    w.connect(U1, NOW - HOUR_MS);
    const cause = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    w.fail(cause);
    const a = stats.load(w.guild).catch((e: unknown) => e);
    const b = stats.load(w.guild).catch((e: unknown) => e);
    stats.record(GUILD, liveNotice('900000000000000001', `<@${U2}> has connected to <#${VC}>`, NOW));
    w.release();
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea).toBeInstanceOf(StatsError);
    expect(ea).toMatchObject({ code: 'history-failed', cause });
    expect(eb).toBe(ea);
    expect(stats.status(GUILD)).toBeNull();

    w.fail(null);
    const history = await stats.load(w.guild);
    expect(history.events.map((e) => e.userId)).toEqual([U1]); // the buffered notice was discarded
  });
});

describe('record', () => {
  it('buffers notices during a scan and merges them without duplicates', async () => {
    const w = world();
    const scanned = w.connect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    const pending = stats.load(w.guild);
    stats.record(GUILD, scanned); // the scan reads it too
    stats.record(GUILD, liveNotice('900000000000000001', `<@${U2}> has connected to <#${VC}>`, NOW - 60_000));
    stats.record(GUILD, liveNotice('900000000000000002', `<@${U3}> has connected to <#${VC}>`, NOW, SYS2));
    w.release();
    const history = await pending;
    expect(history.events.map((e) => e.id)).toEqual([scanned.id, '900000000000000001']);
  });

  it('appends to a built cache and ignores duplicates, other channels and other authors', async () => {
    const w = world();
    const first = w.connect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    await stats.load(w.guild);

    stats.record(GUILD, liveNotice('900000000000000001', `<@${U1}> has disconnected from <#${VC}>`, NOW));
    stats.record(GUILD, first);
    stats.record(GUILD, liveNotice('900000000000000002', `<@${U2}> has connected to <#${VC}>`, NOW, SYS2));
    stats.record(GUILD, liveNotice('900000000000000003', `<@${U2}> has connected to <#${VC}>`, NOW, SYS, U2));
    stats.record('999999999999999999', liveNotice('900000000000000004', `<@${U2}> has connected to <#${VC}>`, NOW));

    const history = await stats.load(w.guild);
    expect(history.events.map((e) => [e.id, e.kind])).toEqual([
      [first.id, 'connect'],
      ['900000000000000001', 'disconnect'],
    ]);
  });

  it('ignores notices for a guild that was never loaded and never throws', () => {
    const w = world();
    const stats = createStatsService({ client: w.client, now: () => NOW });
    stats.record(GUILD, liveNotice('900000000000000001', `<@${U1}> has connected to <#${VC}>`, NOW));
    expect(stats.status(GUILD)).toBeNull();
    expect(() => stats.record(GUILD, null as unknown as NoticeMessage)).not.toThrow();
  });
});

describe('forget', () => {
  it('drops deleted notices from a built cache, only in its channel', async () => {
    const w = world();
    const a = w.connect(U1, NOW - 2 * HOUR_MS);
    const b = w.disconnect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    await stats.load(w.guild);

    stats.forget(GUILD, SYS2, [a.id]);
    expect((await stats.load(w.guild)).events).toHaveLength(2);
    stats.forget(GUILD, SYS, new Set([a.id]).values());
    expect((await stats.load(w.guild)).events.map((e) => e.id)).toEqual([b.id]);
    expect(() => stats.forget('999999999999999999', SYS, [b.id])).not.toThrow();
  });

  it('applies deletes that happen during a scan', async () => {
    const w = world();
    const a = w.connect(U1, NOW - 2 * HOUR_MS);
    const b = w.disconnect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    const pending = stats.load(w.guild);
    stats.record(GUILD, liveNotice('900000000000000001', `<@${U2}> has connected to <#${VC}>`, NOW));
    stats.forget(GUILD, SYS, [a.id, '900000000000000001']);
    w.release();
    expect((await pending).events.map((e) => e.id)).toEqual([b.id]);
  });
});

describe('invalidation', () => {
  it('rescans when the system channel changes', async () => {
    const w = world();
    w.connect(U1, NOW - HOUR_MS);
    w.connect(U2, NOW - HOUR_MS, SYS2);
    w.connect(U3, NOW - 30 * 60_000, SYS2);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    expect((await stats.load(w.guild)).channelId).toBe(SYS);

    w.raw.systemChannel = w.channels[SYS2];
    const history = await stats.load(w.guild);
    expect(history.channelId).toBe(SYS2);
    expect(history.events.map((e) => e.userId)).toEqual([U2, U3]);
    expect(w.channels[SYS2].messages.fetch).toHaveBeenCalledTimes(1);

    // Notices in the old channel no longer count.
    stats.record(GUILD, liveNotice('900000000000000001', `<@${U1}> has connected to <#${VC}>`, NOW, SYS));
    expect(stats.status(GUILD)?.events).toBe(2);
  });

  it('serves the new channel when it changes mid-scan, ignoring the stale scan', async () => {
    const w = world();
    for (let i = 150; i > 0; i--) w.connect(U1, NOW - i * 60_000); // two pages: the stale scan finishes last
    w.connect(U2, NOW - HOUR_MS, SYS2);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    const stale = stats.load(w.guild);
    await flush();
    w.raw.systemChannel = w.channels[SYS2];
    const current = stats.load(w.guild);
    stats.record(GUILD, liveNotice('900000000000000001', `<@${U3}> has connected to <#${VC}>`, NOW, SYS2));
    stats.record(GUILD, liveNotice('900000000000000002', `<@${U1}> has connected to <#${VC}>`, NOW, SYS)); // old channel
    w.release();

    const [staleHistory, history] = await Promise.all([stale, current]);
    expect(staleHistory.channelId).toBe(SYS);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(2);
    expect(history.channelId).toBe(SYS2);
    expect(history.events.map((e) => e.userId)).toEqual([U2, U3]);

    const again = await stats.load(w.guild);
    expect(again.channelId).toBe(SYS2);
    expect(again.events.map((e) => e.id)).toEqual(history.events.map((e) => e.id));
    expect(w.channels[SYS2].messages.fetch).toHaveBeenCalledTimes(1);
    expect(stats.status(GUILD)).toEqual({ events: 2, oldestEventAt: NOW - HOUR_MS, building: false });
  });

  it('keeps the new scan registered when the stale one finishes first', async () => {
    const w = world();
    w.connect(U1, NOW - HOUR_MS);
    for (let i = 150; i > 0; i--) w.connect(U2, NOW - i * 60_000, SYS2); // two pages
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    const stale = stats.load(w.guild);
    await flush();
    w.raw.systemChannel = w.channels[SYS2];
    const current = stats.load(w.guild);
    w.release();
    w.hold(); // the new scan's second page waits

    await stale;
    expect(stats.status(GUILD)).toEqual({ events: 0, oldestEventAt: null, building: true });
    expect(stats.load(w.guild)).toBe(current); // joins the running scan instead of starting another
    w.release();
    expect((await current).events).toHaveLength(150);
    expect(stats.status(GUILD)).toMatchObject({ events: 150, building: false });
    await stats.load(w.guild);
    expect(w.channels[SYS2].messages.fetch).toHaveBeenCalledTimes(2);
  });

  it('caches nothing from a scan that was dropped mid-way', async () => {
    const w = world();
    w.connect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    w.hold();
    const pending = stats.load(w.guild);
    await flush();
    stats.dropGuild(GUILD);
    w.release();
    await pending;
    expect(stats.status(GUILD)).toBeNull();

    await stats.load(w.guild);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(2);
  });

  it('trims events that fall behind the horizon on later loads', async () => {
    const w = world();
    let now = NOW;
    w.connect(U1, NOW - 8 * DAY_MS);
    w.connect(U2, NOW - 2 * DAY_MS);
    const stats = createStatsService({ client: w.client, now: () => now, cacheDays: 10 });
    expect((await stats.load(w.guild)).events).toHaveLength(2);

    now = NOW + 5 * DAY_MS;
    const history = await stats.load(w.guild);
    expect(history.events.map((e) => e.userId)).toEqual([U2]);
    expect(history.oldestEventAt).toBe(NOW - 2 * DAY_MS);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(1);
  });

  it('recomputes coverage against the moving cutoff after trimming', async () => {
    const w = world();
    let now = NOW;
    for (let i = 0; i < 120; i++) w.post(SYS, 'hello', NOW - 40 * DAY_MS + i * HOUR_MS, U2); // older chat
    w.connect(U1, NOW - 9 * DAY_MS);
    w.connect(U2, NOW - DAY_MS);
    const stats = createStatsService({ client: w.client, now: () => now, cacheDays: 10 });
    expect((await stats.load(w.guild)).oldestEventAt).toBe(NOW - 10 * DAY_MS);

    now = NOW + DAY_MS + 12 * HOUR_MS; // U1 trimmed; U2 is 7.5 days after the cutoff: past the slack
    let history = await stats.load(w.guild);
    expect(history.events.map((e) => e.userId)).toEqual([U2]);
    expect(history.oldestEventAt).toBe(NOW - DAY_MS);

    now = NOW + 3 * DAY_MS; // U2 is 6 days after the cutoff
    history = await stats.load(w.guild);
    expect(history.oldestEventAt).toBe(now - 10 * DAY_MS);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(1);
  });

  it('dropGuild forgets everything', async () => {
    const w = world();
    w.connect(U1, NOW - HOUR_MS);
    const stats = createStatsService({ client: w.client, now: () => NOW });
    stats.noteStartup(w.guild);
    await stats.load(w.guild);
    stats.dropGuild(GUILD);
    expect(stats.status(GUILD)).toBeNull();
    const history = await stats.load(w.guild);
    expect(history.checkpoints).toEqual([]);
    expect(w.channels[SYS].messages.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('noteStartup', () => {
  it('snapshots everyone in voice except known bots, even before the first load', async () => {
    const w = world();
    let now = NOW - HOUR_MS;
    w.voiceStates.set(U1, { id: U1, channelId: VC, member: { id: U1, displayName: 'a', user: { username: 'a', bot: false } } });
    w.voiceStates.set(U2, { id: U2, channelId: null, member: { id: U2, displayName: 'b', user: { username: 'b', bot: false } } });
    w.voiceStates.set(BOT, { id: BOT, channelId: VC2, member: { id: BOT, displayName: 'bot', user: { username: 'bot', bot: true } } });
    w.voiceStates.set(U3, { id: U3, channelId: VC2, member: null });
    const stats = createStatsService({ client: w.client, now: () => now });

    stats.noteStartup(w.guild);
    expect(stats.status(GUILD)).toBeNull();
    now = NOW;
    const history = await stats.load(w.guild);
    expect(history.checkpoints).toEqual([
      {
        at: NOW - HOUR_MS,
        present: new Map([
          [U1, VC],
          [U3, VC2],
        ]),
      },
    ]);
  });

  it('keeps only the last few checkpoints and never throws', async () => {
    const w = world();
    let now = NOW - DAY_MS;
    const stats = createStatsService({ client: w.client, now: () => now });
    for (let i = 0; i < 8; i++) {
      stats.noteStartup(w.guild);
      now += HOUR_MS;
    }
    now = NOW;
    const history = await stats.load(w.guild);
    expect(history.checkpoints.map((c) => c.at)).toEqual([3, 4, 5, 6, 7].map((i) => NOW - DAY_MS + i * HOUR_MS));
    expect(() => stats.noteStartup({ id: GUILD, name: 'x' } as unknown as Guild)).not.toThrow();
  });
});

describe('people', () => {
  it('resolves members in batches, former members via the user API, then Former member', async () => {
    const w = world();
    const ids = Array.from({ length: 150 }, (_, i) => String(700000000000001000n + BigInt(i)));
    for (const id of ids.slice(0, 148)) w.member(id, `nick-${id.slice(-3)}`, `user-${id.slice(-3)}`);
    w.member(U1, '', 'plainname'); // no display name: fall back to the username
    w.member(U2, 'Robo', 'robo', true);
    w.users.set(ids[148]!, { username: 'gone-user', bot: false });
    const stats = createStatsService({ client: w.client, now: () => NOW });

    const names = await stats.people(w.guild, [...ids, U1, U2, ids[0]!]);

    const batches = w.raw.members.fetch.mock.calls.map(([arg]) => (arg as { user: string[] }).user.length);
    expect(batches).toEqual([100, 52]);
    expect(names.size).toBe(152);
    expect(names.get(ids[0]!)).toEqual({ name: `nick-${ids[0]!.slice(-3)}`, bot: false });
    expect(names.get(U1)).toEqual({ name: 'plainname', bot: false });
    expect(names.get(U2)).toEqual({ name: 'Robo', bot: true });
    expect(names.get(ids[148]!)).toEqual({ name: 'gone-user', bot: false });
    expect(names.get(ids[149]!)).toEqual({ name: 'Former member', bot: false });
    expect(w.rawClient.users.fetch).toHaveBeenCalledTimes(2);
  });

  it('names former members by their global display name, else their username', async () => {
    const w = world();
    w.users.set(U1, { username: 'alice', globalName: 'Alice A.', bot: false });
    w.users.set(U2, { username: 'bob', bot: false });
    const stats = createStatsService({ client: w.client, now: () => NOW });
    const names = await stats.people(w.guild, [U1, U2]);
    expect(names.get(U1)).toEqual({ name: 'Alice A.', bot: false });
    expect(names.get(U2)).toEqual({ name: 'bob', bot: false });
  });

  it('caches names until the TTL runs out', async () => {
    const w = world();
    let now = NOW;
    w.member(U1, 'Alice', 'alice');
    const stats = createStatsService({ client: w.client, now: () => now, peopleTtlMs: HOUR_MS });

    expect((await stats.people(w.guild, [U1])).get(U1)?.name).toBe('Alice');
    w.member(U1, 'Alice 2', 'alice');
    now += HOUR_MS - 1;
    expect((await stats.people(w.guild, [U1])).get(U1)?.name).toBe('Alice');
    expect(w.raw.members.fetch).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await stats.people(w.guild, [U1])).get(U1)?.name).toBe('Alice 2');
    expect(w.raw.members.fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to one-by-one lookups when the gateway request fails', async () => {
    const w = world();
    w.member(U1, 'Alice', 'alice');
    w.users.set(U2, { username: 'bob', bot: false });
    const batch = w.raw.members.fetch.getMockImplementation()!;
    w.raw.members.fetch.mockImplementation(async (arg) => {
      if (typeof arg !== 'string') throw new Error('Members did not arrive in time');
      return batch(arg);
    });
    const stats = createStatsService({ client: w.client, now: () => NOW });

    const names = await stats.people(w.guild, [U1, U2, U3]);
    expect(names.get(U1)).toEqual({ name: 'Alice', bot: false });
    expect(names.get(U2)).toEqual({ name: 'bob', bot: false });
    expect(names.get(U3)).toEqual({ name: 'Former member', bot: false });
    expect(w.raw.members.fetch).toHaveBeenCalledWith(U1);
    expect(w.rawClient.users.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('coverageStart', () => {
  const cutoff = NOW - 10 * DAY_MS;
  const at = (ms: number) => [{ id: '1', at: ms, kind: 'connect', userId: U1, channelId: VC }] as never;

  it('is null without events', () => {
    expect(coverageStart([], true, cutoff)).toBeNull();
  });

  it('snaps to the cutoff only within the slack of a horizon-reaching history', () => {
    expect(coverageStart(at(cutoff + 7 * DAY_MS), true, cutoff)).toBe(cutoff);
    expect(coverageStart(at(cutoff + 7 * DAY_MS + 1), true, cutoff)).toBe(cutoff + 7 * DAY_MS + 1);
    expect(coverageStart(at(cutoff + HOUR_MS), false, cutoff)).toBe(cutoff + HOUR_MS);
  });
});
