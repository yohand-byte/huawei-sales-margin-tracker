import { describe, expect, it } from 'vitest';
import { parseCatalogFromHtml } from './catalog';

describe('parseCatalogFromHtml', () => {
  it('converts USD to EUR and adds transport per unit from remote settings', () => {
    const html = `
      <script>
        const defaultLocalCharges = [
          { amountAED: 1100, included: true },
          { amountAED: 314, included: true },
          { amountAED: 65, included: true },
          { amountAED: 50, included: true },
          { amountAED: 40, included: true },
          { amountAED: 400, included: true },
          { amountAED: 110, included: true },
          { amountAED: 575, included: true },
          { amountAED: 120, included: true },
          { amountAED: 170, included: false }
        ];
        const shippingProductsSeed = [
          { no: 1, description: 'SUN2000-10K-LC0', qty: 496, unitPriceUSD: 694, weightKg: 19.3, marginPercent: null }
        ];
        const state = {
          exchangeRate: 0.8566,
          freightQuoteEUR: 4511.58,
          customsCostsEUR: 2614.00,
          containerCount: 1,
          aedToUsdRate: 3.6725
        };
      </script>
    `;

    const catalog = parseCatalogFromHtml(html);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].ref).toBe('SUN2000-10K-LC0');
    expect(catalog[0].buy_price_unit).toBe(610.15);
    expect(catalog[0].order).toBe(1);
    expect(catalog[0].datasheet_url).toBeTruthy();
  });
});
