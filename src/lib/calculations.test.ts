import { describe, expect, it } from 'vitest';
import { computeCommission } from './calculations';

describe('computeCommission', () => {
  it('applies Sun.store inverter Stripe tier and fixed Stripe fee behavior', () => {
    const result = computeCommission({
      channel: 'Sun.store',
      category: 'Inverters',
      payment_method: 'Stripe',
      transaction_value: 1070,
      power_wp: null,
    });

    expect(result.commission_rate_display).toBe('3.99%');
    expect(result.commission_eur).toBe(42.7);
    expect(result.payment_fee).toBe(5);
  });

  it('applies Sun.store accessories Wire rate for 80k-99,999 tier', () => {
    const result = computeCommission({
      channel: 'Sun.store',
      category: 'Accessories',
      payment_method: 'Wire',
      transaction_value: 90000,
      power_wp: null,
    });

    expect(result.commission_rate_display).toBe('2.37%');
    expect(result.commission_eur).toBe(2133);
    expect(result.payment_fee).toBe(0);
  });

  it('applies Sun.store solar panels high-tier rate from 150,000 and above', () => {
    const result = computeCommission({
      channel: 'Sun.store',
      category: 'Solar Panels',
      payment_method: 'Wire',
      transaction_value: 150000,
      power_wp: null,
    });

    expect(result.commission_rate_display).toBe('0.97%');
    expect(result.commission_eur).toBe(1455);
    expect(result.payment_fee).toBe(0);
  });

  it('applies Solartraders standard 5% for non-solar-panels categories', () => {
    const result = computeCommission({
      channel: 'Solartraders',
      category: 'Batteries',
      payment_method: 'Wire',
      transaction_value: 20000,
      power_wp: null,
    });

    expect(result.commission_rate_display).toBe('5%');
    expect(result.commission_eur).toBe(1000);
    expect(result.payment_fee).toBe(0);
  });

  it('applies Solartraders 1 cent/Wp for panels at or above 1,000,000 Wp', () => {
    const result = computeCommission({
      channel: 'Solartraders',
      category: 'Solar Panels',
      payment_method: 'Wire',
      transaction_value: 999,
      power_wp: 1_200_000,
    });

    expect(result.commission_rate_display).toBe('1 cent/Wp');
    expect(result.commission_eur).toBe(12000);
    expect(result.payment_fee).toBe(0);
  });
});
