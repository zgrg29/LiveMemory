import {createHash, randomBytes} from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Time-sortable identifier (ULID-like, Crockford base32).
 * 48 bits of millisecond timestamp + 80 bits of randomness.
 */
export function createId(prefix = '') {
  const time = Date.now();
  let timePart = '';
  let remaining = time;
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[remaining % 32] + timePart;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(10);
  let randomPart = '';
  for (const byte of bytes) randomPart += CROCKFORD[byte % 32];
  const id = `${timePart}${randomPart}`;
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256Hex(value, length = 32) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
