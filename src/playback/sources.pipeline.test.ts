import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Fake child processes that never produce output until killed. */
const children = vi.hoisted(() => [] as { kill: ReturnType<typeof vi.fn>; args: string[] }[]);

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
      args,
      kill: vi.fn((signal: string) => {
        child.signalCode = signal;
        child.emit('close', null);
        return true;
      }),
    });
    children.push(child);
    return child;
  }),
}));

const { openTrackInput, runYtDlpResolve } = await import('./sources.js');
const deps = { freshAttachmentUrl: vi.fn(async () => 'https://cdn.discordapp.com/a.mp3') };

afterEach(() => {
  children.length = 0;
  vi.clearAllMocks();
});

describe('cancellation', () => {
  it('kills a loading yt-dlp + ffmpeg pipeline as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const open = openTrackInput({ kind: 'ytdlp', url: 'https://youtu.be/abc' }, deps, controller.signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    controller.abort();
    await expect(open).rejects.toMatchObject({ message: 'Cancelled.' });
    for (const child of children) expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not spawn anything when already aborted (e.g. after the fresh-URL fetch)', async () => {
    const controller = new AbortController();
    deps.freshAttachmentUrl.mockImplementationOnce(async () => {
      controller.abort();
      return 'https://cdn.discordapp.com/a.mp3';
    });
    await expect(
      openTrackInput({ kind: 'library-file', guildId: 'g', soundId: 's' }, deps, controller.signal),
    ).rejects.toMatchObject({ message: 'Cancelled.' });
    expect(children).toHaveLength(0);
  });

  it('kills an in-flight yt-dlp resolve when the signal aborts', async () => {
    const controller = new AbortController();
    const resolve = runYtDlpResolve('https://youtu.be/abc', controller.signal);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort();
    await expect(resolve).rejects.toMatchObject({ code: 'extraction-failed' });
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
