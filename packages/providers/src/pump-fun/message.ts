/** Narrow untrusted PumpPortal data before updating graph/counter state. */
export interface PumpMessage {
  mint: string;
  txType?: 'buy' | 'sell';
  name?: string;
  symbol?: string;
  signature?: string;
  uri?: string;
  traderPublicKey?: string;
  bondingCurveKey?: string;
  initialBuy?: number;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  solAmount?: number;
  tokenAmount?: number;
  newTokenBalance?: number;
}

export function parsePumpMessage(value: unknown): PumpMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mint !== 'string' || !raw.mint || raw.mint.length > 128) return null;
  if (raw.txType !== undefined && raw.txType !== 'buy' && raw.txType !== 'sell') return null;
  const result: PumpMessage = { mint: raw.mint, txType: raw.txType };
  for (const key of ['name', 'symbol', 'signature', 'uri', 'traderPublicKey', 'bondingCurveKey'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].length > 4096) return null;
    result[key] = raw[key];
  }
  for (const key of ['vTokensInBondingCurve', 'vSolInBondingCurve', 'initialBuy', 'marketCapSol', 'solAmount', 'tokenAmount', 'newTokenBalance'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) return null;
    result[key] = raw[key];
  }
  return result;
}
