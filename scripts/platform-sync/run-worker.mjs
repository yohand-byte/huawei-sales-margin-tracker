import { spawn } from 'node:child_process';
import process from 'node:process';

const POLL_INTERVAL_SECONDS = Number(process.env.SYNC_POLL_INTERVAL_SECONDS ?? '300');
const RUN_ONCE = process.env.SYNC_RUN_ONCE === 'true';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runPoll = () =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/platform-sync/poll-imap.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`poll-imap exited with code ${code}`));
    });
  });

const main = async () => {
  if (!Number.isFinite(POLL_INTERVAL_SECONDS) || POLL_INTERVAL_SECONDS < 30) {
    throw new Error('SYNC_POLL_INTERVAL_SECONDS must be >= 30.');
  }

  console.log(
    JSON.stringify({
      status: 'worker_started',
      poll_interval_seconds: POLL_INTERVAL_SECONDS,
      run_once: RUN_ONCE,
      started_at: new Date().toISOString(),
    }),
  );

  do {
    const startedAt = new Date().toISOString();
    try {
      await runPoll();
      console.log(JSON.stringify({ status: 'poll_ok', started_at: startedAt, finished_at: new Date().toISOString() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ status: 'poll_error', started_at: startedAt, error: message }));
    }

    if (RUN_ONCE) {
      break;
    }

    await wait(POLL_INTERVAL_SECONDS * 1000);
  } while (true);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
