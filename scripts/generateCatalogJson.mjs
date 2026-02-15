import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const seedFilePath = path.join(rootDir, 'src', 'lib', 'seed.ts');
const primaryOutputPath = path.join(rootDir, 'public', 'catalog.json');
const secondaryOutputPath = path.join(rootDir, 'public', 'data', 'catalog.json');

const round2 = (value) => Math.round(value * 100) / 100;

function parseSeedCatalogItems(seedSource) {
  const objectRegex = /\{([\s\S]*?)\}/g;

  const getStringField = (block, field) => {
    const m = block.match(new RegExp(`${field}:\\s*'([^']+)'`));
    return m ? m[1].trim() : null;
  };

  const getNumberField = (block, field) => {
    const m = block.match(new RegExp(`${field}:\\s*([0-9]+(?:\\.[0-9]+)?)`));
    return m ? Number(m[1]) : null;
  };

  const bySku = new Map();
  let match = objectRegex.exec(seedSource);

  while (match) {
    const block = match[1];
    const sku = getStringField(block, 'product_ref');
    const category = getStringField(block, 'category');
    const buyPrice = getNumberField(block, 'buy_price_unit');
    const qty = getNumberField(block, 'quantity');

    if (sku && category && Number.isFinite(buyPrice) && Number.isFinite(qty)) {
      const existing = bySku.get(sku);
      if (!existing) {
        bySku.set(sku, {
          sku,
          category,
          buy_price_eur: round2(buyPrice),
          stock_qty: Math.trunc(qty)
        });
      } else {
        existing.stock_qty += Math.trunc(qty);
      }
    }

    match = objectRegex.exec(seedSource);
  }

  return Array.from(bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
}

async function writeOutputs(items) {
  const payload = {
    generated_at: new Date().toISOString(),
    items
  };

  await mkdir(path.dirname(primaryOutputPath), { recursive: true });
  await mkdir(path.dirname(secondaryOutputPath), { recursive: true });

  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(primaryOutputPath, body, 'utf8');
  await writeFile(secondaryOutputPath, body, 'utf8');

  console.log(`[catalog-json] wrote ${items.length} items to public/catalog.json and public/data/catalog.json`);
}

async function main() {
  const seedSource = await readFile(seedFilePath, 'utf8');
  const items = parseSeedCatalogItems(seedSource);

  if (items.length === 0) {
    throw new Error(
      'No local catalog data found in src/lib/seed.ts. Refusing to generate empty catalog.json.'
    );
  }

  await writeOutputs(items);
}

main().catch((error) => {
  console.error(`[catalog-json] fatal: ${error.message}`);
  process.exitCode = 1;
});
