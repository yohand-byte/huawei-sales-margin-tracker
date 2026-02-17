import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { chromium } from 'playwright-core';

const EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() ?? '';
const STATE_PATH = process.env.PLAYWRIGHT_STATE_PATH?.trim() ?? '';
const START_URL =
  process.env.PLAYWRIGHT_LOGIN_URL?.trim() ??
  'https://sun.store/en/sign-in';

const requireValue = (name, value) => {
  if (!value || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
};

const main = async () => {
  requireValue('PLAYWRIGHT_EXECUTABLE_PATH', EXECUTABLE_PATH);
  requireValue('PLAYWRIGHT_STATE_PATH', STATE_PATH);

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    executablePath: EXECUTABLE_PATH,
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Browser opened. Log in manually, then press Enter here to save storage state.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question('Press Enter after login is complete... ');
    await context.storageState({ path: STATE_PATH });
    console.log(`Storage state saved to ${STATE_PATH}`);
  } finally {
    rl.close();
    await browser.close();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
