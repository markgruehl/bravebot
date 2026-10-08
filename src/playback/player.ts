/**
 * Per-guild playback manager on @discordjs/voice (PLAYBACK implementer).
 * Implements the PlayerManager contract in src/types.ts. Uses queue.ts for state and
 * sources.ts for resolution / ffmpeg. One VoiceConnection + AudioPlayer per guild.
 * Volume: createAudioResource(..., { inputType: StreamType.Raw, inlineVolume: true }) and
 * resource.volume.setVolume(percent / 100).
 *
 * Lifecycle of a guild session:
 *   play() -> join (entersState Ready) -> enqueue -> openTrackInput -> AudioPlayer
 *   -> track ends / errors -> next item ... -> queue empty -> leave (destroy connection).
 * A session object is created per join and discarded on leave, so stale callbacks from
 * an old session are recognised by identity (`sessions.get(guildId) !== session`).
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioPlayerState,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits, type Client, type VoiceState } from 'discord.js';
import { VOLUME_DEFAULT, VOLUME_MAX, VOLUME_MIN } from '../constants.js';
import { errorMessage, PlaybackError, type PlaybackErrorCode } from '../errors.js';
import type {
  GuildPlaybackStatus,
  PlayerEventListener,
  PlayerEventName,
  PlayerEvents,
  PlayerManager,
  PlayRequest,
  PlayResult,
  QueueItem,
  SkipResult,
  SourceSummary,
  StopResult,
  TrackInfo,
  VolumeResult,
} from '../types.js';
import { emptyQueue, enqueue, skip, stop, trackEnded, type QueueState, type QueueTransition } from './queue.js';
import { openTrackInput, resolveSource, summarizeSource, type TrackStream } from './sources.js';

export interface PlayerManagerDeps {
  readonly client: Client;
  /** Fresh attachment URL for a library file sound (delegates to the guild's LibraryStore). */
  freshAttachmentUrl(guildId: string, soundId: string): Promise<string>;
}

/** Max time to reach VoiceConnectionStatus.Ready after joining. */
const JOIN_TIMEOUT_MS = 20_000;
/** Grace period for a Disconnected connection to start reconnecting (channel move) before giving up. */
const RECONNECT_GRACE_MS = 5_000;
/** Max time a once-Ready connection may sit in Signalling/Connecting (voice drop) before we leave. */
const RECOVER_TIMEOUT_MS = 20_000;

const STOPPED_BEFORE_START_MESSAGE = 'Playback was stopped before it could start.';

const BUSY_ELSEWHERE_MESSAGE =
  "I'm already playing in another voice channel on this server. Join that channel, or wait until it finishes.";

/** Clamp a volume percent into [VOLUME_MIN, VOLUME_MAX]; NaN falls back to the default. */
export function clampVolume(percent: number): number {
  if (!Number.isFinite(percent)) return VOLUME_DEFAULT;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(percent)));
}

/** Public view of a queue item (drops the play-time input). */
export function toTrackInfo(item: QueueItem): TrackInfo {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    requester: item.requester,
    volume: item.volume,
    requestedAt: item.requestedAt,
    playlistIndex: item.playlistIndex,
    playlistSize: item.playlistSize,
  };
}

interface ResourceMeta {
  readonly itemId: string;
}

/** The track currently owned by the session (== queue.current once loaded). */
interface ActiveTrack {
  readonly item: QueueItem;
  /** Live volume percent (changed by /volume). */
  volume: number;
  stream: TrackStream | null;
  resource: AudioResource<ResourceMeta> | null;
  /** trackStart already emitted (Playing can be re-entered after buffering/auto-pause). */
  announced: boolean;
  /** trackError already emitted for this track. */
  errored: boolean;
  /** Aborted when the track is detached (interrupt / skip / stop / teardown) to kill a still-loading pipeline. */
  readonly abort: AbortController;
}

interface Session {
  readonly guildId: string;
  /** Voice channel the bot is in (or joining); updated when an admin moves the bot. */
  channelId: string;
  readonly connection: VoiceConnection;
  readonly audioPlayer: AudioPlayer;
  /** Resolves when the connection first becomes Ready; rejects on timeout or teardown. */
  ready: Promise<void>;
  /** Aborts the pending join (teardown while still connecting). */
  readonly joinAbort: AbortController;
  isReady: boolean;
  /** stop() was called (distinguishes "stopped while joining" from a failed join). */
  stopRequested: boolean;
  /** play() calls currently awaiting `ready` (the last one out releases an empty session). */
  waiters: number;
  /** Pending wait for a lost connection to become Ready again (aborted on teardown). */
  recovery: AbortController | null;
  queue: QueueState<QueueItem>;
  active: ActiveTrack | null;
  closed: boolean;
}

class DiscordPlayerManager implements PlayerManager {
  private readonly sessions = new Map<string, Session>();
  private readonly emitter = new EventEmitter();
  /**
   * Per-guild stop generation, bumped ONLY by an explicit stop() (and guild teardown).
   * play() captures it before resolving and gives up if it changed, so /stop also cancels
   * plays that are still resolving (e.g. a large playlist) instead of letting them rejoin.
   */
  private readonly stopGen = new Map<string, number>();
  /** Aborted by stop(): kills in-flight yt-dlp resolves for the guild. */
  private readonly resolveAborts = new Map<string, AbortController>();
  /** guildId -> (target voiceChannelId -> number of play() calls not yet enqueued or failed). */
  private readonly pendingTargets = new Map<string, Map<string, number>>();

  constructor(private readonly deps: PlayerManagerDeps) {}

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<E extends PlayerEventName>(event: E, listener: PlayerEventListener<E>): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends PlayerEventName>(event: E, listener: PlayerEventListener<E>): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private emit<E extends PlayerEventName>(event: E, ...args: PlayerEvents[E]): void {
    // A misbehaving listener must never break playback.
    for (const listener of this.emitter.listeners(event)) {
      try {
        (listener as (...a: PlayerEvents[E]) => void)(...args);
      } catch (err) {
        console.error(`[player] ${event} listener threw:`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  currentChannelId(guildId: string): string | null {
    return this.sessions.get(guildId)?.channelId ?? null;
  }

  isBusyElsewhere(guildId: string, channelId: string): boolean {
    const current = this.currentChannelId(guildId);
    return current !== null && current !== channelId;
  }

  hasPendingPlay(guildId: string, channelId: string): boolean {
    return (this.pendingTargets.get(guildId)?.get(channelId) ?? 0) > 0;
  }

  getStatus(guildId: string): GuildPlaybackStatus {
    const session = this.sessions.get(guildId);
    if (!session) {
      return { guildId, channelId: null, state: 'idle', current: null, currentVolume: null, upcoming: [] };
    }
    const current = session.queue.current;
    return {
      guildId,
      channelId: session.channelId,
      state: !session.isReady ? 'connecting' : current ? 'playing' : 'idle',
      current: current ? toTrackInfo(current) : null,
      currentVolume: current ? (session.active?.volume ?? current.volume) : null,
      upcoming: session.queue.upcoming.map(toTrackInfo),
    };
  }

  // -------------------------------------------------------------------------
  // play
  // -------------------------------------------------------------------------

  async play(req: PlayRequest): Promise<PlayResult> {
    let summary: SourceSummary;
    try {
      summary = summarizeSource(req.source);
    } catch {
      summary = { type: req.source.type, label: req.source.type, url: null, libraryName: null };
    }
    const fail = (code: PlaybackErrorCode, message: string, detail: string | null = null): PlayResult => ({
      ok: false,
      code,
      message,
      detail,
      source: summary,
    });
    const gen = this.stopGen.get(req.guildId) ?? 0;
    const stoppedSince = (): boolean => (this.stopGen.get(req.guildId) ?? 0) !== gen;

    if (this.isBusyElsewhere(req.guildId, req.voiceChannelId)) return fail('busy-elsewhere', BUSY_ELSEWHERE_MESSAGE);

    // Pending until enqueued or failed, so /stop can cancel it before the bot has joined.
    this.trackPending(req.guildId, req.voiceChannelId, 1);
    try {
      return await this.resolveJoinEnqueue(req, summary, fail, stoppedSince);
    } finally {
      this.trackPending(req.guildId, req.voiceChannelId, -1);
    }
  }

  private async resolveJoinEnqueue(
    req: PlayRequest,
    summary: SourceSummary,
    fail: (code: PlaybackErrorCode, message: string, detail?: string | null) => PlayResult,
    stoppedSince: () => boolean,
  ): Promise<PlayResult> {
    // 1. Resolve (may be slow: yt-dlp). stop() aborts the signal and kills yt-dlp.
    let resolved;
    try {
      resolved = await resolveSource(req.source, this.resolveAbortFor(req.guildId).signal);
    } catch (err) {
      if (stoppedSince()) return fail('join-failed', STOPPED_BEFORE_START_MESSAGE);
      if (err instanceof PlaybackError) return fail(err.code, err.message, err.detail);
      console.error('[player] unexpected resolve error:', err);
      return fail('extraction-failed', 'Could not read that source.', errorMessage(err));
    }
    if (stoppedSince()) return fail('join-failed', STOPPED_BEFORE_START_MESSAGE);
    if (resolved.length === 0) return fail('empty-playlist', 'Nothing playable was found.');

    // 2. Re-check: the bot may have joined another channel while we were resolving.
    if (this.isBusyElsewhere(req.guildId, req.voiceChannelId)) return fail('busy-elsewhere', BUSY_ELSEWHERE_MESSAGE);

    // 3. Join (or reuse) the requester's channel.
    let session: Session;
    try {
      session = this.getOrJoin(req.guildId, req.voiceChannelId);
    } catch (err) {
      if (err instanceof PlaybackError) return fail(err.code, err.message);
      console.error('[player] unexpected join error:', err);
      return fail('join-failed', 'Could not join your voice channel.');
    }
    session.waiters++;
    try {
      await session.ready;
    } catch {
      if (session.stopRequested || stoppedSince()) return fail('join-failed', STOPPED_BEFORE_START_MESSAGE);
      return fail('join-failed', 'Could not connect to your voice channel. Check that I can Connect and Speak there.');
    } finally {
      session.waiters--;
    }
    if (stoppedSince() || session.closed || this.sessions.get(req.guildId) !== session) {
      return fail('join-failed', STOPPED_BEFORE_START_MESSAGE);
    }
    if (session.channelId !== req.voiceChannelId) {
      // Moved by an admin while joining. Leave if nothing else will use this session.
      this.releaseIfEmpty(session);
      return fail('busy-elsewhere', BUSY_ELSEWHERE_MESSAGE);
    }

    // 4. Enqueue.
    const volume = clampVolume(req.volume);
    const requestedAt = new Date();
    const items: QueueItem[] = resolved.map((track, index) => ({
      id: randomUUID(),
      title: track.title,
      source: summary,
      requester: req.requester,
      volume,
      requestedAt,
      playlistIndex: index,
      playlistSize: resolved.length,
      input: track.input,
    }));
    const transition = enqueue(session.queue, items, req.mode);
    const first = items[0];
    const startedNow = first !== undefined && transition.start === first;
    this.apply(session, transition);

    const queuePosition = startedNow || !first ? 0 : session.queue.upcoming.indexOf(first) + 1;
    return { ok: true, tracks: items.map(toTrackInfo), startedNow, queuePosition, source: summary };
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  stop(guildId: string): StopResult | null {
    // Always cancel plays that are still resolving, even when no session exists yet.
    this.cancelPending(guildId);
    const session = this.sessions.get(guildId);
    if (!session) return null;
    const stopped = session.queue.current ? toTrackInfo(session.queue.current) : null;
    const cleared = session.queue.upcoming.length;
    session.stopRequested = true;
    // stop() always leaves (also aborts a connection that is still joining).
    this.apply(session, stop(session.queue));
    // A session existed and was torn down: report it even if nothing had started yet.
    return { stopped, cleared };
  }

  skip(guildId: string): SkipResult | null {
    const session = this.sessions.get(guildId);
    if (!session?.queue.current) return null;
    const transition = skip(session.queue);
    const result: SkipResult = {
      skipped: transition.stopped ? toTrackInfo(transition.stopped) : null,
      next: transition.start ? toTrackInfo(transition.start) : null,
    };
    this.apply(session, transition);
    return result;
  }

  setVolume(guildId: string, percent: number): VolumeResult | null {
    const session = this.sessions.get(guildId);
    const current = session?.queue.current;
    const active = session?.active;
    if (!session || !current || !active || active.item.id !== current.id) return null;
    const to = clampVolume(percent);
    const from = active.volume;
    active.volume = to;
    active.resource?.volume?.setVolume(to / 100);
    return { track: toTrackInfo(current), from, to };
  }

  // -------------------------------------------------------------------------
  // External voice state / teardown
  // -------------------------------------------------------------------------

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const botId = this.deps.client.user?.id;
    if (!botId || newState.id !== botId) return;
    const session = this.sessions.get(newState.guild.id);
    if (!session) return;

    if (newState.channelId === null) {
      // Disconnected by someone else. Only for a READY session in the channel that was left:
      // after our own leave, the delayed "left" update for the OLD session can arrive while
      // a NEW session is still joining (gateway events are ordered, so it always precedes
      // the new session becoming Ready) and must not tear the new one down. Kicks during a
      // join are still covered by the connection's Disconnected/Destroyed handlers.
      if (session.isReady && oldState.channelId === session.channelId) this.teardown(session);
      return;
    }
    if (newState.channelId !== session.channelId) {
      // Moved by an admin: @discordjs/voice follows the move; keep playing there.
      session.channelId = newState.channelId;
    }
  }

  destroyGuild(guildId: string): void {
    this.cancelPending(guildId);
    const session = this.sessions.get(guildId);
    if (session) this.teardown(session);
  }

  destroyAll(): void {
    for (const guildId of [...this.resolveAborts.keys()]) this.cancelPending(guildId);
    for (const session of [...this.sessions.values()]) this.teardown(session);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Shared per-guild AbortController for in-flight resolves (replaced after each stop()). */
  private resolveAbortFor(guildId: string): AbortController {
    let controller = this.resolveAborts.get(guildId);
    if (!controller) {
      controller = new AbortController();
      this.resolveAborts.set(guildId, controller);
    }
    return controller;
  }

  private trackPending(guildId: string, channelId: string, delta: 1 | -1): void {
    const targets = this.pendingTargets.get(guildId) ?? new Map<string, number>();
    const count = (targets.get(channelId) ?? 0) + delta;
    if (count > 0) targets.set(channelId, count);
    else targets.delete(channelId);
    if (targets.size > 0) this.pendingTargets.set(guildId, targets);
    else this.pendingTargets.delete(guildId);
  }

  /**
   * Leave a joined session that ended up with nothing to play (e.g. the play that created it
   * bailed out after the join). Other plays still awaiting `ready` decrement `waiters` in
   * order, so the last one out decides; any of them that enqueues keeps the session.
   */
  private releaseIfEmpty(session: Session): void {
    if (session.closed || this.sessions.get(session.guildId) !== session) return;
    if (session.waiters > 0 || session.active || session.queue.current || session.queue.upcoming.length > 0) return;
    this.teardown(session);
  }

  /**
   * Cancel plays still resolving for the guild (explicit stop / guild teardown only).
   * Guild-wide on purpose: only one channel per guild can be joined anyway, so cancelling a
   * concurrent resolve for another channel loses nothing that could have played meanwhile.
   */
  private cancelPending(guildId: string): void {
    this.stopGen.set(guildId, (this.stopGen.get(guildId) ?? 0) + 1);
    this.resolveAborts.get(guildId)?.abort();
    this.resolveAborts.delete(guildId);
  }

  /** Existing session for the channel, or a new connection. Throws PlaybackError('join-failed'). */
  private getOrJoin(guildId: string, channelId: string): Session {
    const existing = this.sessions.get(guildId);
    if (existing && !existing.closed) {
      if (existing.channelId !== channelId) throw new PlaybackError('busy-elsewhere', BUSY_ELSEWHERE_MESSAGE);
      return existing;
    }

    const guild = this.deps.client.guilds.cache.get(guildId);
    if (!guild) throw new PlaybackError('join-failed', 'I am not in that server anymore.');
    const channel = guild.channels.cache.get(channelId);
    if (channel?.type === ChannelType.GuildStageVoice) {
      // Defense in depth (interactions reject Stage channels first): the bot would join suppressed and be silent.
      throw new PlaybackError('join-failed', "Sounds can't be played into Stage channels. Join a regular voice channel.");
    }
    if (channel && channel.isVoiceBased()) {
      const me = guild.members.me;
      if (!channel.joinable) throw new PlaybackError('join-failed', 'I cannot join your voice channel (missing permission or it is full).');
      if (me && !channel.permissionsFor(me).has(PermissionFlagsBits.Speak)) {
        throw new PlaybackError('join-failed', 'I do not have permission to speak in your voice channel.');
      }
    }

    const connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    const session: Session = {
      guildId,
      channelId,
      connection,
      audioPlayer,
      ready: Promise.resolve(),
      joinAbort: new AbortController(),
      isReady: false,
      stopRequested: false,
      waiters: 0,
      recovery: null,
      queue: emptyQueue<QueueItem>(),
      active: null,
      closed: false,
    };
    const joinTimer = setTimeout(() => session.joinAbort.abort(), JOIN_TIMEOUT_MS);
    session.ready = entersState(connection, VoiceConnectionStatus.Ready, session.joinAbort.signal).then(
      () => {
        clearTimeout(joinTimer);
        session.isReady = true;
      },
      (err: unknown) => {
        clearTimeout(joinTimer);
        if (!session.closed) {
          console.error(`[player] join failed in guild ${guildId}:`, errorMessage(err));
          this.teardown(session);
        }
        throw err;
      },
    );
    // Avoid an unhandled rejection when nobody awaits (e.g. stop() during connecting).
    session.ready.catch(() => {});
    this.sessions.set(guildId, session);

    connection.subscribe(audioPlayer);
    this.wireConnection(session);
    this.wireAudioPlayer(session);
    return session;
  }

  private wireConnection(session: Session): void {
    const { connection } = session;
    connection.on('error', (err) => {
      console.error(`[player] voice connection error in guild ${session.guildId}:`, err);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // A move between channels shows up as a brief Disconnected -> Signalling/Connecting.
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
      ]).catch(() => {
        if (!session.closed) this.teardown(session);
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (!session.closed) this.teardown(session);
    });
    // After a voice drop @discordjs/voice may go Ready -> Signalling/Connecting directly (no
    // Disconnected) and retry forever. Give it RECOVER_TIMEOUT_MS to become Ready again,
    // otherwise leave, so a dead connection cannot hold the guild "busy" indefinitely.
    connection.on('stateChange', (_old, next) => {
      if (session.closed || !session.isReady || session.recovery) return;
      if (next.status !== VoiceConnectionStatus.Signalling && next.status !== VoiceConnectionStatus.Connecting) return;
      const recovery = new AbortController();
      session.recovery = recovery;
      const timer = setTimeout(() => recovery.abort(), RECOVER_TIMEOUT_MS);
      entersState(connection, VoiceConnectionStatus.Ready, recovery.signal)
        .then(
          () => {},
          () => {
            if (session.closed || this.sessions.get(session.guildId) !== session) return;
            console.error(`[player] voice connection in guild ${session.guildId} did not recover; leaving`);
            this.teardown(session);
          },
        )
        .finally(() => {
          clearTimeout(timer);
          if (session.recovery === recovery) session.recovery = null;
        });
    });
  }

  private wireAudioPlayer(session: Session): void {
    const { audioPlayer } = session;

    audioPlayer.on('error', (err) => {
      const meta = (err.resource as AudioResource<ResourceMeta>).metadata;
      const active = session.active;
      if (!active || meta.itemId !== active.item.id) return;
      this.reportError(session, active, 'playback-failed', err);
      // The player transitions to Idle next; the Idle handler advances the queue.
    });

    audioPlayer.on('stateChange', (oldState: AudioPlayerState, newState: AudioPlayerState) => {
      if (session.closed) return;
      const active = session.active;

      if (newState.status === AudioPlayerStatus.Playing && active && !active.announced) {
        const meta = (newState.resource as AudioResource<ResourceMeta>).metadata;
        if (meta.itemId === active.item.id) {
          active.announced = true;
          this.emit('trackStart', {
            guildId: session.guildId,
            channelId: session.channelId,
            track: toTrackInfo(active.item),
          });
        }
      }

      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        const meta = (oldState.resource as AudioResource<ResourceMeta>).metadata;
        // Only the ACTIVE track ending advances the queue; stopped/replaced tracks are ignored.
        if (active && meta.itemId === active.item.id) {
          this.apply(session, trackEnded(session.queue));
        }
      }
    });
  }

  private reportError(session: Session, active: ActiveTrack, code: PlaybackErrorCode, error: Error): void {
    if (active.errored) return;
    active.errored = true;
    console.error(`[player] track "${active.item.title}" failed in guild ${session.guildId}:`, error.message);
    this.emit('trackError', {
      guildId: session.guildId,
      channelId: session.channelId,
      track: toTrackInfo(active.item),
      code,
      error,
    });
  }

  /** Execute a queue transition: stop the old track, start the new one, or leave. */
  private apply(session: Session, transition: QueueTransition<QueueItem>): void {
    if (session.closed) return;
    session.queue = transition.state;

    // Detach the old track BEFORE stopping the AudioPlayer: stop() emits Idle synchronously,
    // and the Idle handler must not mistake it for the active track ending.
    const previous = session.active;
    if (previous && previous.item.id !== session.queue.current?.id) {
      session.active = null;
      previous.abort.abort(); // kills a pipeline that is still loading (no first audio yet)
      previous.stream?.kill();
      if (previous.resource && session.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
        session.audioPlayer.stop(true);
      }
    }

    if (transition.start) {
      this.start(session, transition.start);
    } else if (transition.idle) {
      this.teardown(session);
    }
  }

  private start(session: Session, item: QueueItem): void {
    const active: ActiveTrack = {
      item,
      volume: item.volume,
      stream: null,
      resource: null,
      announced: false,
      errored: false,
      abort: new AbortController(),
    };
    session.active = active;

    openTrackInput(item.input, { freshAttachmentUrl: this.deps.freshAttachmentUrl }, active.abort.signal).then(
      (stream) => {
        if (session.closed || session.active !== active) {
          stream.kill(); // superseded while loading (interrupt / skip / stop)
          return;
        }
        active.stream = stream;
        try {
          const resource = createAudioResource<ResourceMeta>(stream.stream, {
            inputType: StreamType.Raw,
            inlineVolume: true,
            metadata: { itemId: item.id },
          });
          resource.volume?.setVolume(active.volume / 100);
          active.resource = resource;
          session.audioPlayer.play(resource);
        } catch (err) {
          stream.kill();
          this.failActive(session, active, 'playback-failed', err);
        }
      },
      (err: unknown) => {
        if (session.closed || session.active !== active) return;
        const code = err instanceof PlaybackError ? err.code : 'playback-failed';
        this.failActive(session, active, code, err);
      },
    );
  }

  /** A track failed before reaching the AudioPlayer: report and advance. */
  private failActive(session: Session, active: ActiveTrack, code: PlaybackErrorCode, err: unknown): void {
    this.reportError(session, active, code, err instanceof Error ? err : new Error(errorMessage(err)));
    if (session.active === active) this.apply(session, trackEnded(session.queue));
  }

  /** Leave the channel and forget the session. Idempotent. */
  private teardown(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.guildId) === session) this.sessions.delete(session.guildId);

    const active = session.active;
    session.active = null;
    session.queue = emptyQueue<QueueItem>();
    if (!session.isReady) session.joinAbort.abort();
    session.recovery?.abort();
    active?.abort.abort();
    active?.stream?.kill();
    try {
      session.audioPlayer.stop(true);
    } catch (err) {
      console.error('[player] audio player stop failed:', err);
    }
    session.audioPlayer.removeAllListeners('stateChange');
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        session.connection.destroy();
      } catch (err) {
        console.error('[player] connection destroy failed:', err);
      }
    }
    this.emit('idle', { guildId: session.guildId, channelId: session.channelId });
  }
}

export function createPlayerManager(deps: PlayerManagerDeps): PlayerManager {
  return new DiscordPlayerManager(deps);
}
