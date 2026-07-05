import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { ApiError } from './ApiError.js';

/**
 * Parse and validate a phone number into the shape stored on User.
 * Accepts international format ("+2348012345678") or national with a default country.
 * Returns { countryCode, nationalNumber, e164 } — e164 is the canonical unique key.
 */
export function parsePhone(raw, defaultCountry = 'NG') {
  const parsed = parsePhoneNumberFromString(String(raw ?? '').trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) {
    throw ApiError.badRequest('Invalid phone number', 'INVALID_PHONE');
  }
  return {
    countryCode: `+${parsed.countryCallingCode}`,
    nationalNumber: parsed.nationalNumber,
    e164: parsed.number,
  };
}
