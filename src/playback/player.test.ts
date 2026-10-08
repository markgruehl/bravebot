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
const { createPlayerManager } = await import('./player.js');

const resolveSource = vi.mocked(sources.resolveSource);
const openTrackInput = vi.mocked(sources.openTrackInput);

const GUILD = 'g1';
const BOT = 'bot';
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

function makeManager() {
  const guild = {
    id: GUILD,
    channels: { cache: new Map() },
    members: { me: null },
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

function botVoiceState(channelId: string | null): VoiceState {
  return { id: BOT, channelId, guild: { id: GUILD } } as unknown as VoiceState;
}

const lastConnection = () => voice.connections.at(-1) as FakeConnection;
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  voice.connections.length = 0;
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
    await expect(play).resolves.toMatchObject({ ok: false, message: 'Playback was stopped before it could start.' });
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

  it('returns a non-null result when stopping a session that is still joining', async () => {
    const players = makeManager();
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    expect(players.currentChannelId(GUILD)).toBe('vc1');

    expect(players.stop(GUILD)).toEqual({ stopped: null, cleared: 0 });
    await expect(play).resolves.toMatchObject({ ok: false, message: 'Playback was stopped before it could start.' });
    expect(players.currentChannelId(GUILD)).toBeNull();
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
    players.stop(GUILD);

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
  it('leaves when the only play bails out because the bot was moved', async () => {
    const players = makeManager();
    const idle = vi.fn();
    players.on('idle', idle);
    resolveSource.mockResolvedValueOnce([track('a')]);
    const play = players.play(request());
    await tick();
    players.handleVoiceStateUpdate(botVoiceState('vc1'), botVoiceState('vc2'));
    lastConnection().makeReady();
    await expect(play).resolves.toMatchObject({ ok: false, code: 'busy-elsewhere' });
    expect(players.currentChannelId(GUILD)).toBeNull();
    expect(lastConnection().destroy).toHaveBeenCalled();
    expect(idle).toHaveBeenCalledTimes(1);
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
