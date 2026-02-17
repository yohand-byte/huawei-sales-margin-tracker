import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const PRODUCT_REF_REGEX = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]{1,}){1,}\b/g;
const CURRENCY_REGEX = /(\d{1,3}(?:[ .]\d{3})*(?:,\d{2})?|\d+(?:[.,]\d{2})?)\s*€/g;

const CHANNEL = process.env.PLAYWRIGHT_CHANNEL?.trim() ?? 'Sun.store';
const NEGOTIATION_ID = process.env.PLAYWRIGHT_NEGOTIATION_ID?.trim() ?? '';
const STATE_PATH = process.env.PLAYWRIGHT_STATE_PATH?.trim() ?? '';
const EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() ?? '';
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const STORE_ID = process.env.SUPABASE_STORE_ID?.trim() ?? 'default-store';

const SUNSTORE_TEMPLATE =
  process.env.SUNSTORE_NEGOTIATION_URL_TEMPLATE?.trim() ??
  'https://sun.store/en/seller/negotiations/{id}';
const SOLARTRADERS_TEMPLATE =
  process.env.SOLARTRADERS_NEGOTIATION_URL_TEMPLATE?.trim() ??
  'https://app.solartraders.com/negotiations/{id}';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim() ?? '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
  process.env.SUPABASE_ANON_KEY?.trim() ??
  process.env.VITE_SUPABASE_ANON_KEY?.trim() ??
  '';

const requireValue = (name, value) => {
  if (!value || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
};

const normalizeMoney = (value) => Number(value.replace(/[ .]/g, '').replace(',', '.'));

const extractProductRefs = (text) =>
  [
    ...new Set(
      (text.match(PRODUCT_REF_REGEX) ?? [])
        .filter((ref) => /\d/.test(ref))
        .filter((ref) => ref.length >= 6 && ref.length <= 40)
        .filter((ref) => ref.includes('-'))
        .filter((ref) => !ref.startsWith('OFF-'))
        .filter((ref) => !ref.includes('-2F'))
        .filter((ref) => !ref.includes('-3D')),
    ),
  ];

const extractAmounts = (text) => {
  const amounts = [];
  for (const match of text.matchAll(CURRENCY_REGEX)) {
    amounts.push(normalizeMoney(match[1]));
  }
  return amounts;
};

const extractTransactionRef = (text) => {
  const match = text.match(/\b(?:pi|ch|cs)_[A-Za-z0-9_]+\b/);
  return match ? match[0] : null;
};

const extractClientName = (text) => {
  const patterns = [/Client\s*:\s*(.+)/i, /Buyer\s*:\s*(.+)/i, /Customer\s*:\s*(.+)/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].split('\n')[0].trim();
    }
  }
  return null;
};

const buildTargetUrl = () => {
  const template = CHANNEL === 'Solartraders' ? SOLARTRADERS_TEMPLATE : SUNSTORE_TEMPLATE;
  return template.replace('{id}', encodeURIComponent(NEGOTIATION_ID));
};

const extractSunStoreBlock = (bodyText) => {
  const lines = bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const marker = `(#${NEGOTIATION_ID})`;
  const markerIndex = lines.findIndex((line) => line.includes(marker));
  if (markerIndex === -1) {
    return null;
  }

  const start = Math.max(0, markerIndex - 1);
  let end = lines.length;
  for (let i = markerIndex + 1; i < lines.length; i += 1) {
    if (/^\(#([A-Za-z0-9]{6,16})\)$/.test(lines[i])) {
      end = Math.max(start + 1, i - 1);
      break;
    }
  }
  return lines.slice(start, end);
};

const parseSunStoreBlock = (lines) => {
  const blockText = lines.join('\n');
  const refs = extractProductRefs(blockText);
  const amounts = extractAmounts(blockText);

  const findAfter = (labelRegex) => {
    const labelIndex = lines.findIndex((line) => labelRegex.test(line));
    if (labelIndex === -1 || labelIndex + 1 >= lines.length) {
      return null;
    }
    return lines[labelIndex + 1];
  };

  const transactionStatus = lines[0] ?? null;
  const shippingLabel = findAfter(/co[ûu]t:/i);
  const shippingCharged = shippingLabel ? normalizeMoney(shippingLabel.replace(/[^\d,.\s]/g, '').trim()) : null;
  const grossLabel = findAfter(/Total de la transaction \(brut\)/i);
  const grossAmount = grossLabel ? normalizeMoney(grossLabel.replace(/[^\d,.\s]/g, '').trim()) : null;
  const country = findAfter(/Livraison [àa]:/i);
  const qtyLine = findAfter(/^Quantit[ée]$/i);
  const quantityMatch = qtyLine?.match(/(\d+(?:[.,]\d+)?)/);
  const quantity = quantityMatch ? Number(quantityMatch[1].replace(',', '.')) : null;

  return {
    block_lines: lines,
    product_refs: refs,
    detected_amounts_eur: amounts,
    transaction_status: transactionStatus,
    shipping_charged: shippingCharged,
    transaction_gross: grossAmount,
    destination_country: country ?? null,
    quantity,
  };
};

const scrapeSunStoreFromSalesPanel = async (context) => {
  const maxPages = Number(process.env.SUNSTORE_PANEL_MAX_PAGES ?? '10');
  const page = await context.newPage();

  for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
    const url = `https://sun.store/fr/panel/sales?tab=all&page=${currentPage}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const bodyText = await page.locator('body').innerText();
    const block = extractSunStoreBlock(bodyText);
    if (!block) {
      continue;
    }

    const parsed = parseSunStoreBlock(block);
    return {
      url: page.url(),
      page_number: currentPage,
      ...parsed,
    };
  }

  return null;
};

const upsertScrapeResult = async (result) => {
  requireValue('SUPABASE_URL', SUPABASE_URL);
  requireValue('SUPABASE key', SUPABASE_KEY);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        'x-store-id': STORE_ID,
      },
    },
  });

  const { error: ingestError } = await supabase.from('ingest_events').upsert(
    {
      store_id: STORE_ID,
      source: 'playwright',
      source_event_id: `${CHANNEL}:${NEGOTIATION_ID}:${new Date().toISOString()}`,
      channel: CHANNEL,
      external_order_id: NEGOTIATION_ID,
      status: 'processed',
      payload: result,
      processed_at: new Date().toISOString(),
    },
    { onConflict: 'store_id,source,source_event_id' },
  );

  if (ingestError) {
    throw new Error(`Failed to insert ingest_event: ${ingestError.message}`);
  }

  const sourcePayload = {
    scrape: result,
  };

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .upsert(
      {
        store_id: STORE_ID,
        channel: CHANNEL,
        external_order_id: NEGOTIATION_ID,
        source_status: 'scraped',
        order_status: result.product_refs.length > 0 ? 'ENRICHI' : 'A_COMPLETER',
        source_event_at: new Date().toISOString(),
        client_name: result.client_name,
        transaction_ref: result.transaction_ref,
        source_payload: sourcePayload,
      },
      { onConflict: 'store_id,channel,external_order_id' },
    )
    .select('id')
    .single();

  if (orderError) {
    throw new Error(`Failed to upsert order: ${orderError.message}`);
  }

  if (result.product_refs.length > 0) {
    const { error: deleteError } = await supabase.from('order_lines').delete().eq('order_id', order.id);
    if (deleteError) {
      throw new Error(`Failed to clear order_lines: ${deleteError.message}`);
    }

    const rows = result.product_refs.map((productRef, index) => ({
      order_id: order.id,
      line_index: index + 1,
      product_ref: productRef,
      quantity: 1,
      source_payload: {
        source: 'playwright',
      },
    }));

    const { error: insertError } = await supabase.from('order_lines').insert(rows);
    if (insertError) {
      throw new Error(`Failed to insert order_lines: ${insertError.message}`);
    }
  }

  const { error: logError } = await supabase.from('sync_logs').insert({
    store_id: STORE_ID,
    component: 'playwright-scraper',
    level: 'info',
    message: `Scrape done for ${CHANNEL} ${NEGOTIATION_ID}`,
    context: {
      product_refs: result.product_refs,
      url: result.url,
    },
  });

  if (logError) {
    throw new Error(`Failed to insert sync_log: ${logError.message}`);
  }
};

const main = async () => {
  requireValue('PLAYWRIGHT_NEGOTIATION_ID', NEGOTIATION_ID);
  requireValue('PLAYWRIGHT_STATE_PATH', STATE_PATH);
  requireValue('PLAYWRIGHT_EXECUTABLE_PATH', EXECUTABLE_PATH);

  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`Playwright state file not found: ${STATE_PATH}`);
  }

  const url = buildTargetUrl();
  const outputDir = path.resolve(process.cwd(), 'output/playwright');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: EXECUTABLE_PATH,
  });

  try {
    const context = await browser.newContext({ storageState: STATE_PATH });
    let result;

    if (CHANNEL === 'Sun.store') {
      const panelResult = await scrapeSunStoreFromSalesPanel(context);
      if (panelResult) {
        const page = context.pages()[context.pages().length - 1];
        const screenshotPath = path.join(
          outputDir,
          `${CHANNEL.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${NEGOTIATION_ID}-${Date.now()}.png`,
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        result = {
          channel: CHANNEL,
          negotiation_id: NEGOTIATION_ID,
          url: panelResult.url,
          product_refs: panelResult.product_refs,
          detected_amounts_eur: panelResult.detected_amounts_eur,
          transaction_ref: null,
          client_name: null,
          transaction_status: panelResult.transaction_status,
          shipping_charged: panelResult.shipping_charged,
          transaction_gross: panelResult.transaction_gross,
          destination_country: panelResult.destination_country,
          quantity: panelResult.quantity,
          page_number: panelResult.page_number,
          block_lines: panelResult.block_lines,
          screenshot_path: screenshotPath,
          scraped_at: new Date().toISOString(),
        };
      }
    }

    if (!result) {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);

      const bodyText = await page.locator('body').innerText();
      const productRefs = extractProductRefs(bodyText);
      const amounts = extractAmounts(bodyText);

      const screenshotPath = path.join(
        outputDir,
        `${CHANNEL.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${NEGOTIATION_ID}-${Date.now()}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });

      result = {
        channel: CHANNEL,
        negotiation_id: NEGOTIATION_ID,
        url,
        product_refs: productRefs,
        detected_amounts_eur: amounts,
        transaction_ref: extractTransactionRef(bodyText),
        client_name: extractClientName(bodyText),
        screenshot_path: screenshotPath,
        scraped_at: new Date().toISOString(),
      };
    }

    if (SUPABASE_URL && SUPABASE_KEY) {
      await upsertScrapeResult(result);
    }

    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
