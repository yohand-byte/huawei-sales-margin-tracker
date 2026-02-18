import process from 'node:process';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL?.trim() ?? '';

export const isSlackConfigured = () => Boolean(SLACK_WEBHOOK_URL);

export const postSlackMessage = async (payload) => {
  if (!SLACK_WEBHOOK_URL) {
    return { ok: false, skipped: true, reason: 'missing_slack_webhook_url' };
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Slack webhook failed (${res.status}): ${text || res.statusText}`);
  }

  return { ok: true };
};

