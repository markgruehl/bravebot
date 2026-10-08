/**
 * Slack webhook mirror. Uses global fetch. No-op when webhook is null/empty.
 * Never throws: failures (network, timeout or non-2xx) are logged with console.error.
 */

/**
 * Escape Slack mrkdwn control characters so user/admin-controlled names cannot inject
 * control sequences (<!channel>, <!here>) or <url|label> links. `&` first to avoid double-escaping.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Upper bound on a single webhook call so a slow Slack never piles up pending requests. */
export const SLACK_TIMEOUT_MS = 10_000;

export async function postToSlack(webhookUrl: string | null, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = webhookUrl?.trim();
  if (!url) return;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[slack] webhook responded ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error('[slack] webhook request failed:', err instanceof Error ? err.message : err);
  }
}
