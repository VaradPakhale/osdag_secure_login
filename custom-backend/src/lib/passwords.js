import { Algorithm, hash, verify } from '@node-rs/argon2';
import { config } from '../config.js';

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: config.argon2.memoryCost,
  timeCost: config.argon2.timeCost,
  parallelism: config.argon2.parallelism,
};

export function hashPassword(plaintext) {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(storedHash, plaintext) {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    // A malformed/truncated hash in the DB must read as "wrong password",
    // never as a 500 that distinguishes this account from any other.
    return false;
  }
}

/**
 * Timing equaliser for the unknown-email path. [ADR-0005, R5.2]
 *
 * Returning an identical 401 body is only half of "generic": if a real account
 * costs ~60ms of argon2 and a missing one returns instantly, the response time
 * is the oracle. So the no-such-user branch verifies against this throwaway
 * hash, paying the same CPU. Built once at startup, from a random secret that
 * exists only in memory.
 */
const DUMMY_HASH = await hash(
  `dummy-password-for-timing-equalisation-${Math.random()}`,
  OPTIONS
);

export async function burnTimingBudget(plaintext) {
  // Always false; the return value exists only so the call cannot be optimised
  // away or mistaken for a real check by a future reader.
  return verifyPassword(DUMMY_HASH, plaintext ?? '');
}
