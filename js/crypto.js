// All encryption happens here, on the device. Nothing readable ever leaves the phone.
// - The shared passphrase is stretched with PBKDF2 (600k rounds) into a 256-bit key.
// - Every record is sealed with AES-256-GCM, using its record id as associated data
//   so ciphertexts can't be swapped between records.
// - Face ID uses a passkey with the WebAuthn PRF extension: the passkey yields a secret
//   that wraps the data key locally. The passphrase itself is never stored.

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ROUNDS = 600000;

export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveKeyBits(passphrase, household) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('our-budget-v1:' + household), iterations: PBKDF2_ROUNDS },
    base, 256);
}

export function importKey(bits) {
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(key, obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return toB64(out);
}

export async function open(key, data, aad) {
  const bytes = fromB64(data);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, key, bytes.slice(12));
  return JSON.parse(dec.decode(pt));
}

// ---------- Face ID (passkey + PRF) ----------

export function biometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

async function wrapKeyFromPrf(prfOutput) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('our-budget-faceid'), info: new Uint8Array() },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function prfAssert(credId, salt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: fromB64(credId) }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: fromB64(salt) } } },
    },
  });
  const out = cred.getClientExtensionResults()?.prf?.results?.first;
  if (!out) throw new Error('This device does not support Face ID unlock for web apps (needs iOS 18+).');
  return out;
}

// Returns the info to store in config, or throws.
export async function enrollBiometric(rawBits, displayName) {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Our Budget' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: displayName || 'me', displayName: displayName || 'me' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      extensions: { prf: {} },
    },
  });
  if (cred.getClientExtensionResults()?.prf?.enabled === false) {
    throw new Error('This device does not support Face ID unlock for web apps (needs iOS 18+).');
  }
  const credId = toB64(cred.rawId);
  const prf = await prfAssert(credId, salt);
  const wk = await wrapKeyFromPrf(prf);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, rawBits);
  return { credId, salt, iv: toB64(iv), wrapped: toB64(wrapped) };
}

export async function unlockBiometric(info) {
  const prf = await prfAssert(info.credId, info.salt);
  const wk = await wrapKeyFromPrf(prf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(info.iv) }, wk, fromB64(info.wrapped));
}
