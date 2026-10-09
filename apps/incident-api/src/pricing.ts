export type OrderType = 'standard' | 'priority';

const UNIT_PRICE = 25;

export function healthyQuote(type: OrderType, quantity: number): number {
  const shippingFee = type === 'priority' ? 15 : 5;
  return UNIT_PRICE * quantity + shippingFee;
}

export function brokenQuote(type: OrderType, quantity: number): number {
  // Regression: the priority branch refers to a rule that does not exist.
  const shippingRules: Record<string, { fee: number }> = {
    standard: { fee: 5 },
    express: { fee: 15 },
  };

  return UNIT_PRICE * quantity + shippingRules[type]!.fee;
}
