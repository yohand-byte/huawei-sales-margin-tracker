import type { Category, Channel, PaymentMethod, SaleComputed, SaleInput } from '../types';

interface CommissionResult {
  commission_rate_display: string;
  commission_eur: number;
  payment_fee: number;
}

interface RateTier {
  min: number;
  max: number | null;
  stripe: number;
  wire: number;
}

const inverterBatteryTiers: RateTier[] = [
  { min: 0, max: 4999.999999, stripe: 0.0399, wire: 0.0519 },
  { min: 5000, max: 9999.999999, stripe: 0.0365, wire: 0.0474 },
  { min: 10000, max: 24999.999999, stripe: 0.0314, wire: 0.0393 },
  { min: 25000, max: 79999.999999, stripe: 0.0261, wire: 0.0326 },
  { min: 80000, max: 149999.999999, stripe: 0.0179, wire: 0.0206 },
  { min: 150000, max: null, stripe: 0.0103, wire: 0.0118 },
];

const solarPanelTiers: RateTier[] = [
  { min: 0, max: 4999.999999, stripe: 0.0299, wire: 0.0389 },
  { min: 5000, max: 9999.999999, stripe: 0.0276, wire: 0.0359 },
  { min: 10000, max: 24999.999999, stripe: 0.0226, wire: 0.0282 },
  { min: 25000, max: 79999.999999, stripe: 0.0181, wire: 0.0226 },
  { min: 80000, max: 149999.999999, stripe: 0.0131, wire: 0.0151 },
  { min: 150000, max: null, stripe: 0.0084, wire: 0.0097 },
];

const accessoriesTiers: RateTier[] = [
  { min: 0, max: 4999.999999, stripe: 0.0488, wire: 0.0634 },
  { min: 5000, max: 9999.999999, stripe: 0.0421, wire: 0.0547 },
  { min: 10000, max: 24999.999999, stripe: 0.0363, wire: 0.0454 },
  { min: 25000, max: 79999.999999, stripe: 0.0301, wire: 0.0376 },
  { min: 80000, max: 99999.999999, stripe: 0.0206, wire: 0.0237 },
  { min: 100000, max: null, stripe: 0.0119, wire: 0.0137 },
];

export const isPowerWpRequired = (channel: Channel, category: Category): boolean =>
  channel === 'Solartraders' && category === 'Solar Panels';

export const round2 = (value: number): number =>
  Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
const roundUp2 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return round2(value);
  }
  return Math.ceil(value * 100) / 100;
};

const pickTier = (value: number, tiers: RateTier[]): RateTier => {
  const found = tiers.find((tier) => {
    const geMin = value >= tier.min;
    const leMax = tier.max === null || value <= tier.max;
    return geMin && leMax;
  });

  return found ?? tiers[tiers.length - 1];
};

const pickSunStoreTable = (category: Category): RateTier[] => {
  if (category === 'Solar Panels') {
    return solarPanelTiers;
  }
  if (category === 'Accessories') {
    return accessoriesTiers;
  }
  return inverterBatteryTiers;
};

const formatPercent = (rate: number): string => `${round2(rate * 100)}%`;

const computeSunStoreCommission = (
  category: Category,
  paymentMethod: PaymentMethod,
  transactionValue: number,
): CommissionResult => {
  const tier = pickTier(transactionValue, pickSunStoreTable(category));
  const rate = paymentMethod === 'Wire' ? tier.wire : tier.stripe;
  const paymentFee = paymentMethod === 'Stripe' ? 5 : 0;
  const rawCommission = transactionValue * rate;
  return {
    commission_rate_display: formatPercent(rate),
    commission_eur: paymentMethod === 'Stripe' ? roundUp2(rawCommission) : round2(rawCommission),
    payment_fee: paymentFee,
  };
};

const computeSolarTradersCommission = (
  category: Category,
  transactionValue: number,
  powerWp: number | null,
): CommissionResult => {
  if (category !== 'Solar Panels') {
    return {
      commission_rate_display: '5%',
      commission_eur: round2(transactionValue * 0.05),
      payment_fee: 0,
    };
  }

  const safePowerWp = powerWp ?? 0;
  if (safePowerWp >= 1_000_000) {
    return {
      commission_rate_display: '1 cent/Wp',
      commission_eur: round2(safePowerWp * 0.01),
      payment_fee: 0,
    };
  }

  return {
    commission_rate_display: '1.5 cent/Wp',
    commission_eur: round2(safePowerWp * 0.015),
    payment_fee: 0,
  };
};

export const computeCommission = ({
  channel,
  category,
  payment_method,
  transaction_value,
  power_wp,
}: {
  channel: Channel;
  category: Category;
  payment_method: PaymentMethod;
  transaction_value: number;
  power_wp: number | null;
}): CommissionResult => {
  if (channel === 'Sun.store') {
    return computeSunStoreCommission(category, payment_method, transaction_value);
  }
  if (channel === 'Solartraders') {
    return computeSolarTradersCommission(category, transaction_value, power_wp);
  }
  return {
    commission_rate_display: '0%',
    commission_eur: 0,
    payment_fee: 0,
  };
};

export const computeSale = (input: SaleInput): SaleComputed => {
  const sellTotalHt = round2(input.quantity * input.sell_price_unit_ht);
  const transactionValue = round2(sellTotalHt + input.shipping_charged);
  const commission = computeCommission({
    channel: input.channel,
    category: input.category,
    payment_method: input.payment_method,
    transaction_value: transactionValue,
    power_wp: input.power_wp,
  });
  const netReceived = round2(transactionValue - commission.commission_eur - commission.payment_fee);
  const totalCost = round2(input.quantity * input.buy_price_unit + input.shipping_real);
  const grossMargin = round2(transactionValue - totalCost);
  const netMargin = round2(netReceived - totalCost);
  const netMarginPct = transactionValue <= 0 ? 0 : round2((netMargin / transactionValue) * 100);

  return {
    sell_total_ht: sellTotalHt,
    transaction_value: transactionValue,
    commission_rate_display: commission.commission_rate_display,
    commission_eur: commission.commission_eur,
    payment_fee: commission.payment_fee,
    net_received: netReceived,
    total_cost: totalCost,
    gross_margin: grossMargin,
    net_margin: netMargin,
    net_margin_pct: netMarginPct,
  };
};
