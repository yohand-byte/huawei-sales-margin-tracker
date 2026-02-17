import { spawn } from 'node:child_process';
import process from 'node:process';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const IMAP_HOST = process.env.IMAP_HOST?.trim() ?? '';
const IMAP_PORT = Number(process.env.IMAP_PORT ?? '993');
const IMAP_SECURE = process.env.IMAP_SECURE !== 'false';
const IMAP_USER = process.env.IMAP_USER?.trim() ?? '';
const IMAP_PASSWORD = process.env.IMAP_PASSWORD?.trim() ?? '';
const IMAP_MAILBOX = process.env.IMAP_MAILBOX?.trim() || 'INBOX';
const IMAP_LOOKBACK_DAYS = Number(process.env.IMAP_LOOKBACK_DAYS ?? '7');
const IMAP_MAX_MESSAGES = Number(process.env.IMAP_MAX_MESSAGES ?? '25');
const IMAP_MARK_SEEN = process.env.IMAP_MARK_SEEN !== 'false';
const PLAYWRIGHT_AUTO_SCRAPE = process.env.PLAYWRIGHT_AUTO_SCRAPE === 'true';
const IMAP_ALLOWED_SENDER_DOMAINS = (process.env.IMAP_ALLOWED_SENDER_DOMAINS ?? 'sun.store,solartraders.com')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const requiredMissing =
  IMAP_HOST.length === 0 || IMAP_USER.length === 0 || IMAP_PASSWORD.length === 0 || !Number.isFinite(IMAP_PORT);

if (requiredMissing) {
  console.error('Missing IMAP settings: IMAP_HOST, IMAP_USER, IMAP_PASSWORD, IMAP_PORT.');
  process.exit(1);
}

const senderAllowed = (fromEntries) => {
  if (!fromEntries || fromEntries.length === 0) {
    return false;
  }

  return fromEntries.some((entry) => {
    const address = (entry?.address ?? '').toLowerCase();
    return IMAP_ALLOWED_SENDER_DOMAINS.some(
      (domain) => address === domain || address.endsWith(`@${domain}`) || address.includes(domain),
    );
  });
};

const normalizeMessageId = (rawMessageId, uid) => {
  const value = (rawMessageId ?? '').trim();
  if (value.length > 0) {
    return value;
  }
  return `<imap-uid-${uid}@local.mailbox>`;
};

const parseText = (parsedMail) => {
  if (typeof parsedMail.text === 'string' && parsedMail.text.trim().length > 0) {
    return parsedMail.text;
  }
  if (typeof parsedMail.html === 'string' && parsedMail.html.trim().length > 0) {
    return parsedMail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
};

const runIngest = (payload) =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/platform-sync/ingest-email.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `ingest-email exited with ${code}`));
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });

const runPlaywrightScrape = ({ negotiationId, channel }) =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/platform-sync/playwright-fetch-order.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLAYWRIGHT_NEGOTIATION_ID: negotiationId,
        PLAYWRIGHT_CHANNEL: channel,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `playwright-fetch-order exited with ${code}`));
    });
  });

const main = async () => {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASSWORD,
    },
    logger: false,
  });

  await client.connect();

  const lock = await client.getMailboxLock(IMAP_MAILBOX);
  const stats = {
    scanned: 0,
    processed: 0,
    skipped_sender: 0,
    failed: 0,
    scraped: 0,
    scrape_failed: 0,
  };

  try {
    const sinceDate = new Date(Date.now() - IMAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const uids = await client.search(
      {
        seen: false,
        since: sinceDate,
      },
      { uid: true },
    );

    const limitedUids = uids.slice(-IMAP_MAX_MESSAGES);

    for (const uid of limitedUids) {
      stats.scanned += 1;

      const message = await client.fetchOne(
        uid,
        {
          uid: true,
          source: true,
          envelope: true,
          internalDate: true,
        },
        { uid: true },
      );

      if (!message?.source) {
        continue;
      }

      const parsed = await simpleParser(message.source);
      const fromEntries = parsed.from?.value ?? message.envelope?.from ?? [];

      if (!senderAllowed(fromEntries)) {
        stats.skipped_sender += 1;
        continue;
      }

      const payload = {
        provider: 'imap',
        message_id: normalizeMessageId(parsed.messageId || message.envelope?.messageId, uid),
        thread_id: null,
        from_email: fromEntries[0]?.address ?? null,
        subject: parsed.subject ?? message.envelope?.subject ?? '',
        text: parseText(parsed),
        received_at: (message.internalDate ?? new Date()).toISOString(),
        payload: {
          imap_uid: uid,
          mailbox: IMAP_MAILBOX,
        },
      };

      try {
        const ingestResult = await runIngest(payload);
        stats.processed += 1;

        let ingestJson = null;
        try {
          ingestJson = JSON.parse(ingestResult);
        } catch {
          ingestJson = null;
        }

        if (IMAP_MARK_SEEN) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }

        console.log(`[OK] uid=${uid} ${ingestResult}`);

        if (
          PLAYWRIGHT_AUTO_SCRAPE &&
          ingestJson &&
          ingestJson.status !== 'duplicate' &&
          typeof ingestJson.negotiation_id === 'string' &&
          ingestJson.negotiation_id.length > 0 &&
          typeof ingestJson.channel === 'string' &&
          ingestJson.channel.length > 0
        ) {
          try {
            const scrapeOutput = await runPlaywrightScrape({
              negotiationId: ingestJson.negotiation_id,
              channel: ingestJson.channel,
            });
            stats.scraped += 1;
            console.log(`[SCRAPE] uid=${uid} ${scrapeOutput}`);
          } catch (error) {
            stats.scrape_failed += 1;
            const messageText = error instanceof Error ? error.message : String(error);
            console.error(`[SCRAPE_ERROR] uid=${uid} ${messageText}`);
          }
        }
      } catch (error) {
        stats.failed += 1;
        const messageText = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] uid=${uid} ${messageText}`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  console.log(JSON.stringify({ status: 'done', ...stats }));
};

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    const code = error.code ? String(error.code) : '';
    const response = error.responseText ? String(error.responseText) : '';
    if (code || response) {
      console.error(JSON.stringify({ code, response }));
    }
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
