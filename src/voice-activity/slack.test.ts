import { afterEach, describe, expect, it, vi } from 'vitest';
import { postToSlack } from './slack.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postToSlack', () => {
  it('does nothing without a webhook', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await postToSlack(null, 'hi', fetchImpl);
    await postToSlack('', 'hi', fetchImpl);
    await postToSlack('   ', 'hi', fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts JSON {text} to the webhook', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    await postToSlack('https://hooks.slack.com/x', 'alice has connected to General', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.com/x');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'alice has connected to General' });
  });

  it('logs and swallows non-2xx responses', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(postToSlack('https://hooks.slack.com/x', 'hi', fetchImpl)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('logs and swallows network errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(postToSlack('https://hooks.slack.com/x', 'hi', fetchImpl)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
