import { describe, expect, it } from 'vitest';
import { parseStripeEvent } from './ingest-stripe-event.mjs';

describe('parseStripeEvent', () => {
  it('parses checkout.session.completed enrichment fields', () => {
    const parsed = parseStripeEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      created: 1771360000,
      data: {
        object: {
          id: 'cs_test_1',
          payment_intent: 'pi_123',
          amount_total: 107000,
          total_details: { amount_shipping: 3000 },
          customer_details: {
            name: 'NAUTIMARKET EUROPE SRL',
            address: { country: 'IT' },
          },
          metadata: {
            negotiation_id: 'wpT5sgv0',
          },
        },
      },
    });

    expect(parsed.external_order_id).toBe('wpT5sgv0');
    expect(parsed.transaction_ref).toBe('pi_123');
    expect(parsed.shipping_charged_ht).toBe(30);
    expect(parsed.net_received).toBe(1070);
    expect(parsed.channel).toBe('Sun.store');
  });

  it('parses charge.succeeded fees when balance transaction is expanded', () => {
    const parsed = parseStripeEvent({
      id: 'evt_2',
      type: 'charge.succeeded',
      created: 1771360100,
      data: {
        object: {
          id: 'ch_123',
          payment_intent: 'pi_abc',
          amount: 107000,
          application_fee_amount: 4270,
          balance_transaction: {
            fee: 4770,
            net: 102230,
          },
          metadata: {
            external_order_id: 'ORD-0001',
          },
        },
      },
    });

    expect(parsed.external_order_id).toBe('ORD-0001');
    expect(parsed.fees_platform).toBe(42.7);
    expect(parsed.fees_stripe).toBe(47.7);
    expect(parsed.net_received).toBe(1022.3);
  });
});
