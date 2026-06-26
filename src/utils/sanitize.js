/**
 * Simple sanitization utility for secure logging
 * Obfuscates sensitive data to prevent accidental exposure
 */

/**
 * Substrings that mark a key as sensitive.
 *
 * A key is masked when its lowercased form CONTAINS any of these tokens
 * (substring match). Tokens are deliberately SHORT so that common secret
 * field names are caught in full — e.g. `secret` catches `secret`,
 * `client_secret`, `stripe_secret_key`, `webhook_secret`, `api_secret`;
 * `password` catches `password`, `app_password`, `wp_password`; `auth`
 * catches `authorization`. A bare `key` token is intentionally avoided so
 * innocuous fields like `description`/`public_key_id`/`key` are not masked.
 *
 * `oauth_signature` / `bearer` / `credit_card` / `cvv` / `ssn` are kept as
 * explicit tokens because no shorter token covers them.
 */
const SENSITIVE_KEYS = [
  'secret', 'password', 'passwd', 'token',
  'api_key', 'apikey', 'private_key', 'app_password',
  'consumer_key', 'consumer_secret',
  'authorization', 'auth', 'credential',
  'oauth_signature', 'bearer',
  'credit_card', 'cvv', 'ssn'
];

/**
 * Mask a sensitive value
 */
function mask(value) {
  // Return null/undefined as-is
  if (value === null || value === undefined) return value;

  // Convert to string for masking
  const str = String(value);
  if (str.length === 0) return '';
  if (str.length <= 8) return '****';
  return str.substring(0, 3) + '****' + str.slice(-2);
}

/**
 * Sanitize an object for logging
 */
export function sanitize(obj, seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return obj;

  // Cut cycles so logging a self-referential object can never stack-overflow.
  if (seen.has(obj)) return Array.isArray(obj) ? [] : {};
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((v) => sanitize(v, seen));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some(k => keyLower.includes(k));

    if (isSensitive) {
      result[key] = mask(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitize(value, seen);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Sanitize a URL string
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return url;

  // Mask consumer keys and secrets in URLs, redact HTTP Basic userinfo, and
  // mask OAuth credential query params (including oauth_signature/oauth_nonce,
  // which the named-param rule below does not cover).
  return url
    // Redact HTTP Basic credentials in the authority: scheme://user:pass@host
    // → scheme://user:***@host. Keep the username for debuggability; never the
    // password. (Userinfo runs from "://" up to the LAST "@" before the host.)
    .replace(/(:\/\/)([^/?#@:]+):([^/?#@]+)@/g, '$1$2:***@')
    .replace(/ck_[a-f0-9]{32}/gi, 'ck_****')
    .replace(/cs_[a-f0-9]{32}/gi, 'cs_****')
    // Any oauth_* query value (oauth_signature, oauth_nonce, oauth_token, …).
    .replace(/(oauth_[a-z0-9_]+)=([^&#]+)/gi, '$1=****')
    .replace(/(consumer_key|consumer_secret|api_key|token)=([^&#]+)/gi, '$1=****');
}

/**
 * Sanitize headers for logging
 */
export function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;

  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const keyLower = key.toLowerCase();

    if (keyLower === 'authorization' || keyLower.includes('api-key')) {
      result[key] = mask(String(value));
    } else {
      result[key] = value;
    }
  }

  return result;
}

export default { sanitize, sanitizeUrl, sanitizeHeaders };