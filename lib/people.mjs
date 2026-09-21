// Manager PINs belong to the person, not to one tournament.
//
// People are matched by name across tournaments ("Walker" in the Masters is "Walker" in the PGA).
// Each person has one PIN, a random salt, and a count of wrong guesses. After MAX_TRIES wrong
// guesses the person is locked until the admin unlocks them or sets a new PIN.
//
// Older tournaments stored a PIN on each draft's manager record. Those still work: the first
// time a manager logs in with one, it becomes their PIN everywhere.

import { createHash, randomBytes } from 'node:crypto';
import { getStore, update } from './store.mjs';

export const MAX_TRIES = 8;
export const PEOPLE_KEY = 'people';

export const personKey = (name) =>
  String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const hashPin = (key, salt, pin) => createHash('sha256').update(`person:${key}:${salt}:${String(pin ?? '').trim()}`).digest('hex');
export const validPin = (pin) => /^\d{4}$/.test(String(pin ?? '').trim());

export async function getPeople() {
  const { data } = await (await getStore()).get(PEOPLE_KEY);
  return data || {};
}

// "managed" means this record owns the PIN; per-draft legacy PINs are ignored from then on.
function describe(people, m) {
  const p = people[personKey(m.name)];
  const managed = !!p?.managed;
  const hasPin = managed ? !!p.pinHash : !!m.pinHash;
  const failed = p?.failed || 0;
  return { hasPin, locked: failed >= MAX_TRIES, failed, managed };
}
export const pinInfo = describe;

async function writePerson(key, fn) {
  const all = await update(PEOPLE_KEY, (cur) => {
    const next = { ...(cur || {}) };
    next[key] = fn(next[key] || { name: '', managed: false, pinHash: null, salt: null, failed: 0 });
    return next;
  });
  return all[key];
}

// Check a manager's PIN, counting wrong guesses. legacyHash(pin) computes the old per-draft hash.
// Returns { ok, noPin?, locked?, left? }.
export async function checkPin(m, pin, legacyHash) {
  const key = personKey(m.name);
  const people = await getPeople();
  const p = people[key];
  const info = describe(people, m);
  if (info.locked) return { ok: false, locked: true, left: 0 };
  if (!info.hasPin) return { ok: true, noPin: true };

  const ok = info.managed ? p.pinHash === hashPin(key, p.salt, pin) : m.pinHash === legacyHash(pin);
  if (ok) {
    // Reset the counter, and adopt a legacy PIN as the person's PIN for every tournament.
    if (!info.managed || info.failed) {
      await writePerson(key, (cur) => {
        if (cur.managed) return { ...cur, name: cur.name || m.name, failed: 0 };
        const salt = randomBytes(12).toString('hex');
        return { ...cur, name: m.name, managed: true, salt, pinHash: hashPin(key, salt, pin), failed: 0, updatedAt: new Date().toISOString() };
      });
    }
    return { ok: true };
  }
  const after = await writePerson(key, (cur) => ({ ...cur, name: cur.name || m.name, failed: (cur.failed || 0) + 1, lastFailedAt: new Date().toISOString() }));
  const left = Math.max(0, MAX_TRIES - after.failed);
  return { ok: false, locked: left === 0, left };
}

export async function setPin(name, pin, { by = 'admin' } = {}) {
  if (!validPin(pin)) throw Object.assign(new Error('PIN must be exactly 4 digits.'), { status: 400 });
  const key = personKey(name);
  if (!key) throw Object.assign(new Error('Missing name.'), { status: 400 });
  const salt = randomBytes(12).toString('hex');
  return writePerson(key, (cur) => ({ ...cur, name: cur.name || String(name).trim(), managed: true, salt, pinHash: hashPin(key, salt, pin), failed: 0, updatedAt: new Date().toISOString(), setBy: by }));
}

export async function clearPin(name) {
  const key = personKey(name);
  return writePerson(key, (cur) => ({ ...cur, name: cur.name || String(name).trim(), managed: true, salt: null, pinHash: null, failed: 0, updatedAt: new Date().toISOString(), setBy: 'admin' }));
}

export async function unlock(name) {
  const key = personKey(name);
  return writePerson(key, (cur) => ({ ...cur, name: cur.name || String(name).trim(), failed: 0 }));
}
