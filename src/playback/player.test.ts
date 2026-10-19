import type { EventEmitter } from 'node:events';
import type * as Voice from '@discordjs/voice';
import type { VoiceState } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioSource, PlayRequest, ResolvedTrack, SourceSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Fakes for @discordjs/voice and sources.ts (no network, no processes)
// ---------------------------------------------------------------------------

interface FakeConnection extends EventEmitter {
  state: { status: string };
  makeReady(): void;
  destroy: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

const voice = vi.hoisted(() => ({ connections: [] as unknown[] }));

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof Voice>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    joinVoiceChannel: vi.fn(() => {
      const readyWaiters: (() => void)[] = [];
      const conn = Object.assign(new Emitter(), {
        state: { status: actual.VoiceConnectionStatus.Signalling as string },
        readyWaiters,
        makeReady() {
          conn.state.status = actual.VoiceConnectionStatus.Ready;
          for (const resolve of readyWaiters.splice(0)) resolve();
        },
        destroy: vi.fn(() => {
          conn.state.status = actual.VoiceConnectionStatus.Destroyed;
        }),
        subscribe: vi.fn(),
      });
      voice.connections.push(conn);
      return conn;
    }),
    entersState: vi.fn(
      (target: { readyWaiters?: (() => void)[] }, status: string, signalOrTimeout: AbortSignal | number) =>
        new Promise<unknown>((resolve, reject) => {
          if (status !== actual.VoiceConnectionStatus.Ready) return; // reconnect races: never settle
          target.readyWaiters?.push(() => resolve(target));
          if (signalOrTimeout instanceof AbortSignal) {
            signalOrTimeout.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }
        }),
    ),
    createAudioPlayer: vi.fn(() =>
      Object.assign(new Emitter(), {
        state: { status: actual.AudioPlayerStatus.Idle },
        play: vi.fn(),
        stop: vi.fn(),
      }),
    ),
    createAudioResource: vi.fn((_stream: unknown, opts: { metadata: unknown }) => ({
      metadata: opts.metadata,
      volume: { setVolume: vi.fn() },
    })),
  };
});

vi.mock('./sources.js', () => ({
  resolveSource: vi.fn(),
  openTrackInput: vi.fn(),
  summarizeSource: (s: AudioSource): SourceSummary => ({
    type: s.type,
    label: s.type,
    url: null,
    libraryName: null,
  }),
}));

const { joinVoiceChannel } = await import('@discordjs/voice');
const sources = await import('./sources.js');
const { createPlayerManager, hasPeople } = await import('./player.js');

const resolveSource = vi.mocked(sources.resolveSource);
const openTrackInput = vi.mocked(sources.openTrackInput);

const GUILD = 'g1';
const BOT = 'bot';
const STOPPED = 'Playback was stopped before it could start.';
const track = (title: string): ResolvedTrack => ({ title, input: { kind: 'direct', url: `https://x.test/${title}.mp3` }, durationSec: null });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Presence {
  id: string;
  channelId: string | null;
  member: { user: { bot: boolean } } | null;
}

/** The fake guild's voice state cache (who is in which channel), reset before each test. */
const presence = new Map<string, Presence>();

function setPresence(id: string, channelId: string | null, bot = false) {
  presence.set(id, { id, channelId, member: { user: { bot } } });
}

function makeManager() {
  const guild = {
    id: GUILD,
    channels: { cache: new Map() },
    members: { me: null },
    voiceStates: { cache: presence },
    voiceAdapterCreator: () => ({}),
  };
  const client = { user: { id: BOT }, guilds: { cache: new Map([[GUILD, guild]]) } };
  return createPlayerManager({ client: client as never, freshAttachmentUrl: vi.fn() });
}

const request = (over: Partial<PlayRequest> = {}): PlayRequest => ({
  guildId: GUILD,
  voiceChannelId: 'vc1',
  requester: { id: 'u1', displayName: 'U' },
  source: { type: 'url', url: 'https://x.test/a.mp3' },
  mode: 'interrupt',
  volume: 100,
  via: 'slash',
  ...over,
});

function voiceState(id: string, channelId: string | null): VoiceState {
  return { id, channelId, guild: { id: GUILD } } as unknown as VoiceState;
}

function botVoiceState(channelId: string | null): VoiceState {
  return voiceState(BOT, channelId);
}

/** Move a person (updating the cache first, as discord.js does) and deliver the update. */
function movePerson(players: ReturnType<typeof makeManager>, id: string, to: string | null) {
  const from = presence.get(id)?.channelId ?? null;
  setPresence(id, to);
  players.handleVoiceStateUpdate(voiceState(id, from), voiceState(id, to));
}

/** A manager whose bot has joined vc1 and is playing (loading) `titles` in order. */
async function playing(...titles: string[]) {
  const players = makeManager();
  resolveSource.mockResolvedValueOnce(titles.map(track));
  const play = players.play(request());
  await tick();
  lastConnection().makeReady();
  await expect(play).resolves.toMatchObject({ ok: true });
  return { players, conn: lastConnection() };
}

const lastConnection = () => voice.connections.at(-1) as FakeConnection;
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  voice.connections.length = 0;
  presence.clear();
  setPresence('u1', 'vc1');
  setPresence('u2', 'vc2');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Default: a pipeline that never produces audio (stays "loading").
  openTrackInput.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('stop() vs in-flight plays', () => {
  it('cancels a play whose source is still resolving (no rejoin after /stop)', async () => {
    const players = makeManager();
    const pending = deferred<ResolvedTrack[]>();
    resolveSource.mockReturnValueOnce(pending.promise);

    const play = players.play(request());
    await tick();
    const signal = resolveSource.mock.calls[0]![1]!;
    expect(signal.aborted).toBe(false);

    expect(players.stop(GUILD)).toBeNull(); // no session yet
    expect(signal.aborted).toBe(true); // yt-dlp would be killed

    pending.resolve([track('a')]);
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(joinVoiceChannel).not.toHaveBeenCalled();
    expect(players.currentChannelId(GUILD)).toBeNull();
  });

  it('does not affect plays requested after the stop', async () => {
    const players = makeManager();
    players.stop(GUILD);
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    lastConnection().makeReady();
    await expect(play).resolves.toMatchObject({ ok: true, startedNow: true });
  });

  it('stops a play whose session is still joining; the bot finishes joining and stays', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    expect(players.currentChannelId(GUILD)).toBe('vc1');

    expect(players.stop(GUILD)).toEqual({ stopped: null, cleared: 0 });
    lastConnection().makeReady();
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(players.getStatus(GUILD)).toMatchObject({ channelId: 'vc1', state: 'idle', current: null });
    expect(lastConnection().destroy).not.toHaveBeenCalled();
  });
});

describe('staying in the channel', () => {
  it('stays when the queue runs out', async () => {
    const left = vi.fn();
    openTrackInput.mockRejectedValueOnce(new Error('ffmpeg exploded'));
    const { players, conn } = await playing('a');
    players.on('left', left);
    await tick();
    expect(players.getStatus(GUILD)).toMatchObject({ channelId: 'vc1', state: 'idle', current: null });
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(left).not.toHaveBeenCalled();
  });

  it('stays when the last track is skipped', async () => {
    const { players, conn } = await playing('a');
    expect(players.skip(GUILD)).toMatchObject({ skipped: { title: 'a' }, next: null });
    expect(players.getStatus(GUILD)).toMatchObject({ channelId: 'vc1', state: 'idle' });
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it('stop() clears the queue but keeps the connection, and has nothing to stop once idle', async () => {
    const { players, conn } = await playing('a', 'b');
    expect(players.stop(GUILD)).toMatchObject({ stopped: { title: 'a' }, cleared: 1 });
    expect(players.getStatus(GUILD)).toMatchObject({ channelId: 'vc1', state: 'idle', upcoming: [] });
    expect(players.stop(GUILD)).toBeNull();
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it('stop() on an idle bot cancels a play still resolving into its channel', async () => {
    const { players } = await playing('a');
    players.stop(GUILD);
    const pending = deferred<ResolvedTrack[]>();
    resolveSource.mockReturnValueOnce(pending.promise);
    const play = players.play(request());
    await tick();
    expect(players.stop(GUILD)).toEqual({ stopped: null, cleared: 0 });
    pending.resolve([track('b')]);
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(players.currentChannelId(GUILD)).toBe('vc1');
  });

  it('plays the next sound on the same connection (no rejoin)', async () => {
    const { players } = await playing('a');
    players.stop(GUILD);
    resolveSource.mockResolvedValueOnce([track('b')]);
    await expect(players.play(request())).resolves.toMatchObject({ ok: true, startedNow: true });
    expect(joinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it('leave() stops, clears and disconnects', async () => {
    const left = vi.fn();
    const { players, conn } = await playing('a', 'b');
    players.on('left', left);
    const loading = openTrackInput.mock.calls[0]![2]!;
    expect(players.leave(GUILD)).toMatchObject({ channelId: 'vc1', stopped: { title: 'a' }, cleared: 1 });
    expect(loading.aborted).toBe(true);
    expect(conn.destroy).toHaveBeenCalled();
    expect(players.currentChannelId(GUILD)).toBeNull();
    expect(left).toHaveBeenCalledWith({ guildId: GUILD, channelId: 'vc1' });
    expect(players.leave(GUILD)).toBeNull();
  });

  it('leave() during resolve cancels the play without joining', async () => {
    const players = makeManager();
    const pending = deferred<ResolvedTrack[]>();
    resolveSource.mockReturnValueOnce(pending.promise);
    const play = players.play(request());
    await tick();
    expect(players.leave(GUILD)).toBeNull();
    pending.resolve([track('a')]);
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('leave() while joining aborts the join', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    expect(players.leave(GUILD)).toEqual({ channelId: 'vc1', stopped: null, cleared: 0 });
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(lastConnection().destroy).toHaveBeenCalled();
    expect(players.currentChannelId(GUILD)).toBeNull();
  });
});

describe('leaving when nobody is left', () => {
  it('leaves when the last person leaves, cutting off what is playing', async () => {
    const left = vi.fn();
    const { players, conn } = await playing('a', 'b');
    players.on('left', left);
    const loading = openTrackInput.mock.calls[0]![2]!;
    movePerson(players, 'u1', null);
    expect(loading.aborted).toBe(true);
    expect(conn.destroy).toHaveBeenCalled();
    expect(players.currentChannelId(GUILD)).toBeNull();
    expect(left).toHaveBeenCalledWith({ guildId: GUILD, channelId: 'vc1' });
  });

  it('stays while someone is still in the channel, and leaves when the last one moves away', async () => {
    setPresence('u3', 'vc1');
    const { players, conn } = await playing('a');
    movePerson(players, 'u1', null);
    expect(players.currentChannelId(GUILD)).toBe('vc1');
    movePerson(players, 'u3', 'vc2');
    expect(conn.destroy).toHaveBeenCalled();
    expect(players.currentChannelId(GUILD)).toBeNull();
  });

  it('does not count other bots as people', async () => {
    setPresence('other-bot', 'vc1', true);
    const { players } = await playing('a');
    movePerson(players, 'u1', null);
    expect(players.currentChannelId(GUILD)).toBeNull();
  });

  it('ignores people leaving other channels', async () => {
    const { players, conn } = await playing('a');
    movePerson(players, 'u2', null);
    movePerson(players, 'u4', 'vc2');
    expect(players.currentChannelId(GUILD)).toBe('vc1');
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it('leaves when the requester leaves while the bot is still joining', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    movePerson(players, 'u1', 'vc2');
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(lastConnection().destroy).toHaveBeenCalled();
    expect(players.currentChannelId(GUILD)).toBeNull();
  });

  it('does not join a channel that emptied while the source was resolving', async () => {
    const players = makeManager();
    const pending = deferred<ResolvedTrack[]>();
    resolveSource.mockReturnValueOnce(pending.promise);
    const play = players.play(request());
    await tick();
    setPresence('u1', null); // no session yet, so the update itself is ignored
    pending.resolve([track('a')]);
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });
});

describe('hasPeople', () => {
  const state = (id: string, channelId: string | null, bot: boolean | null = false) => ({
    id,
    channelId,
    member: bot === null ? null : { user: { bot } },
  });

  it('is true for a person in the channel', () => {
    expect(hasPeople([state('u1', 'vc1')], 'vc1', BOT)).toBe(true);
  });

  it('ignores other channels, bots and the bot itself', () => {
    expect(hasPeople([], 'vc1', BOT)).toBe(false);
    expect(hasPeople([state('u1', 'vc2'), state('u2', null)], 'vc1', BOT)).toBe(false);
    expect(hasPeople([state('b1', 'vc1', true)], 'vc1', BOT)).toBe(false);
    expect(hasPeople([state(BOT, 'vc1', null)], 'vc1', BOT)).toBe(false);
  });

  it('counts a member missing from the cache as a person', () => {
    expect(hasPeople([state('u1', 'vc1', null)], 'vc1', BOT)).toBe(true);
  });
});

describe('handleVoiceStateUpdate', () => {
  it('ignores a stale "left voice" update while a new session is still joining', async () => {
    const players = makeManager();

    // Session 1 plays and is stopped (bot sends its leave).
    resolveSource.mockResolvedValueOnce([track('a')]);
    const first = players.play(request());
    await tick();
    lastConnection().makeReady();
    await first;
    players.leave(GUILD);

    // Session 2 starts joining the same channel before the leave's voice-state update arrives.
    resolveSource.mockResolvedValueOnce([track('b')]);
    const second = players.play(request());
    await tick();
    expect(players.currentChannelId(GUILD)).toBe('vc1');

    players.handleVoiceStateUpdate(botVoiceState('vc1'), botVoiceState(null)); // stale, from session 1
    expect(players.currentChannelId(GUILD)).toBe('vc1');

    lastConnection().makeReady();
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('still tears down a ready session that was disconnected', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    lastConnection().makeReady();
    await play;

    players.handleVoiceStateUpdate(botVoiceState('vc1'), botVoiceState(null));
    expect(players.currentChannelId(GUILD)).toBeNull();
    expect(lastConnection().destroy).toHaveBeenCalled();
  });
});

describe('superseded tracks', () => {
  it('aborts the loading pipeline of a track that is interrupted', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const first = players.play(request());
    await tick();
    lastConnection().makeReady();
    await first;
    const firstSignal = openTrackInput.mock.calls[0]![2]!;
    expect(firstSignal.aborted).toBe(false);

    resolveSource.mockResolvedValueOnce([track('b')]);
    await players.play(request());
    expect(firstSignal.aborted).toBe(true);
    expect(openTrackInput.mock.calls[1]![2]!.aborted).toBe(false);

    players.stop(GUILD);
    expect(openTrackInput.mock.calls[1]![2]!.aborted).toBe(true);
  });
});

describe('pending plays', () => {
  it('reports a play as pending while it resolves, and not after it succeeds or fails', async () => {
    const players = makeManager();
    const ok = deferred<ResolvedTrack[]>();
    resolveSource.mockReturnValueOnce(ok.promise);
    const play = players.play(request());
    await tick();
    expect(players.hasPendingPlay(GUILD, 'vc1')).toBe(true);
    expect(players.hasPendingPlay(GUILD, 'vc2')).toBe(false);
    ok.resolve([track('a')]);
    await tick();
    lastConnection().makeReady();
    await expect(play).resolves.toMatchObject({ ok: true });
    expect(players.hasPendingPlay(GUILD, 'vc1')).toBe(false);

    players.stop(GUILD);
    resolveSource.mockRejectedValueOnce(new Error('yt-dlp exploded'));
    const failing = players.play(request());
    expect(players.hasPendingPlay(GUILD, 'vc1')).toBe(true);
    await expect(failing).resolves.toMatchObject({ ok: false });
    expect(players.hasPendingPlay(GUILD, 'vc1')).toBe(false);
  });

  it('stop() during resolve clears the pending play without joining', async () => {
    const players = makeManager();
    const pending = deferred<ResolvedTrack[]>();
    resolveSource.mockReturnValueOnce(pending.promise);
    const play = players.play(request());
    await tick();
    players.stop(GUILD);
    pending.resolve([track('a')]);
    await expect(play).resolves.toMatchObject({ ok: false });
    expect(players.hasPendingPlay(GUILD, 'vc1')).toBe(false);
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });
});

describe('moved by an admin while joining', () => {
  it('stays in the new channel when it has people (the play bails out)', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    players.handleVoiceStateUpdate(botVoiceState('vc1'), botVoiceState('vc2'));
    lastConnection().makeReady();
    await expect(play).resolves.toMatchObject({ ok: false, code: 'busy-elsewhere' });
    expect(players.currentChannelId(GUILD)).toBe('vc2');
    expect(lastConnection().destroy).not.toHaveBeenCalled();
  });

  it('leaves when moved into an empty channel', async () => {
    const players = makeManager();
    const left = vi.fn();
    players.on('left', left);
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    players.handleVoiceStateUpdate(botVoiceState('vc1'), botVoiceState('vc3'));
    await expect(play).resolves.toMatchObject({ ok: false, message: STOPPED });
    expect(players.currentChannelId(GUILD)).toBeNull();
    expect(lastConnection().destroy).toHaveBeenCalled();
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when another waiting play targets the new channel', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const first = players.play(request());
    await tick();
    players.handleVoiceStateUpdate(botVoiceState('vc1'), botVoiceState('vc2'));
    resolveSource.mockResolvedValueOnce([track('b')]);
    const second = players.play(request({ voiceChannelId: 'vc2' }));
    await tick();
    lastConnection().makeReady();
    await expect(first).resolves.toMatchObject({ ok: false, code: 'busy-elsewhere' });
    await expect(second).resolves.toMatchObject({ ok: true, startedNow: true });
    expect(players.currentChannelId(GUILD)).toBe('vc2');
    expect(lastConnection().destroy).not.toHaveBeenCalled();
  });
});

describe('voice connection recovery', () => {
  async function readySession() {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    lastConnection().makeReady();
    await play;
    return { players, conn: lastConnection() };
  }

  function dropTo(conn: FakeConnection, status: string) {
    const old = { ...conn.state };
    conn.state.status = status;
    conn.emit('stateChange', old, { status });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves when a once-Ready connection is stuck in Signalling', async () => {
    const { players, conn } = await readySession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dropTo(conn, 'signalling');
    dropTo(conn, 'connecting'); // further flips do not stack another wait
    vi.advanceTimersByTime(19_000);
    await tick();
    expect(players.currentChannelId(GUILD)).toBe('vc1');
    vi.advanceTimersByTime(1_000);
    await tick();
    expect(players.currentChannelId(GUILD)).toBeNull();
    expect(conn.destroy).toHaveBeenCalled();
  });

  it('stays when the connection becomes Ready again in time', async () => {
    const { players, conn } = await readySession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dropTo(conn, 'signalling');
    conn.makeReady();
    await tick();
    vi.advanceTimersByTime(30_000);
    await tick();
    expect(players.currentChannelId(GUILD)).toBe('vc1');
    expect(conn.destroy).not.toHaveBeenCalled();
  });
});
