/**
 * FakeShop catalogue (MER-11, §5.8): 5 seeded Aurora Experiences SKUs.
 * Prices are integer pence. Exported as fixtures for VAL-9's seed. This is
 * MERCHANT-side data — deliberately a native shape, not a platform contract
 * (P5: the shop only knows the webhook wire contract).
 */
export interface CatalogueSku {
  sku: string;
  name: string;
  price_pence: number;
}

export const CATALOGUE: readonly CatalogueSku[] = [
  { sku: 'sku_spa_day', name: 'Full spa day', price_pence: 8450 }, // §10 Act 1's £84.50 order
  { sku: 'sku_lunch', name: 'Tasting-menu lunch for two', price_pence: 6200 },
  { sku: 'sku_massage', name: 'Hot-stone massage', price_pence: 4500 },
  { sku: 'sku_yoga_class', name: 'Sunrise yoga class', price_pence: 1800 },
  { sku: 'sku_candle', name: 'Aurora signature candle', price_pence: 2400 },
];

export const skuByRef = (sku: string): CatalogueSku | undefined =>
  CATALOGUE.find((entry) => entry.sku === sku);
