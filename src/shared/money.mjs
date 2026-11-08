/**
 * Money handling.
 *
 * All persisted amounts are integer *minor units* of an ISO-4217 currency
 * (CNY/USD/EUR: cents, JPY/KRW: whole yen/won). Floating point is never used
 * for storage or arithmetic, which keeps long-term totals exact.
 */
export const DEFAULT_CURRENCY = 'CNY';

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);
const TWO_DECIMAL = new Set(['CNY', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'HKD', 'TWD', 'SGD', 'NZD', 'CHF', 'MXN', 'BRL']);

export function normalizeCurrency(value, fallback = DEFAULT_CURRENCY) {
  if (value === null || value === undefined) return fallback;
  const raw = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(raw)) return fallback;
  return raw;
}

/** Number of decimal digits used by a currency in the UI. */
export function currencyDigits(currency) {
  const code = normalizeCurrency(currency);
  if (ZERO_DECIMAL.has(code)) return 0;
  if (TWO_DECIMAL.has(code)) return 2;
  return 2;
}

export function minorUnitFactor(currency) {
  return 10 ** currencyDigits(currency);
}

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d*))?$/;

/**
 * Parse a human written amount ("12.34", 12.34, "1,200.00", "500 円") into
 * integer minor units. Returns null when the value is not a usable amount.
 * Values with more decimals than the currency supports are rounded half away
 * from zero on the last supported digit.
 */
export function parseAmountToMinor(value, currency = DEFAULT_CURRENCY) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const code = normalizeCurrency(currency);
  const digits = currencyDigits(code);
  const text = typeof value === 'number'
    ? (Number.isInteger(value) ? String(value) : value.toFixed(digits + 2))
    : String(value);
  const cleaned = text.replace(/[,\s\u00a0]/g, '').replace(/[^\d.+-]/g, '');
  const match = DECIMAL_PATTERN.exec(cleaned);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '0';
  let fraction = match[3] ?? '';
  if (fraction.length > digits) {
    const keep = fraction.slice(0, digits);
    const nextDigit = Number(fraction.charAt(digits));
    fraction = keep;
    if (nextDigit >= 5) {
      // Round up on the integer minor unit.
      const bumped = String(Number(keep.padEnd(digits, '0') || '0') + 1).padStart(digits, '0');
      if (bumped.length > digits) {
        const carryWhole = String(Number(whole) + 1);
        return sign * (Number(carryWhole) * minorUnitFactor(code));
      }
      fraction = bumped;
    }
  }
  const fractionValue = digits === 0 ? 0 : Number(fraction.padEnd(digits, '0') || '0');
  const minor = Number(whole) * minorUnitFactor(code) + fractionValue;
  if (!Number.isSafeInteger(minor)) return null;
  return sign * minor;
}

/** Render integer minor units as a plain decimal string ("12.34", "500"). */
export function formatMinorAmount(minor, currency = DEFAULT_CURRENCY) {
  if (minor === null || minor === undefined) return null;
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return null;
  const code = normalizeCurrency(currency);
  const digits = currencyDigits(code);
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(amount));
  if (digits === 0) return `${sign}${abs}`;
  const factor = 10 ** digits;
  const whole = Math.floor(abs / factor);
  const fraction = String(abs % factor).padStart(digits, '0');
  return `${sign}${whole}.${fraction}`;
}

/**
 * Multiply a unit price by a quantity without floating point drift.
 * Returns null when the unit price is unknown.
 */
export function multiplyMinor(unitMinor, quantity) {
  if (unitMinor === null || unitMinor === undefined) return null;
  const qty = Number(quantity ?? 1);
  if (!Number.isSafeInteger(qty) || qty <= 0) return null;
  const total = Number(unitMinor) * qty;
  return Number.isSafeInteger(total) ? total : null;
}
