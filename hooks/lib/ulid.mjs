import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms) {
  let str = '';
  for (let i = 9; i >= 0; i--) {
    str = CROCKFORD[ms & 31] + str;
    ms = Math.floor(ms / 32);
  }
  return str;
}

function encodeRandom() {
  const bytes = randomBytes(10);
  return Array.from(bytes, b => CROCKFORD[b & 31]).join('');
}

export function ulid(seedTime = Date.now()) {
  return encodeTime(seedTime) + encodeRandom();
}
