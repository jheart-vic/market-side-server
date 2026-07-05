import { customAlphabet } from 'nanoid';

// Unambiguous uppercase alphabet (no 0/O, 1/I/L) — codes are typed and shared by humans.
const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const generate = customAlphabet(alphabet, 8);

export function generateReferralCode() {
  return generate();
}

/** Generate a code that doesn't collide with an existing user's. */
export async function generateUniqueReferralCode(UserModel, maxTries = 5) {
  for (let i = 0; i < maxTries; i += 1) {
    const code = generateReferralCode();
    const exists = await UserModel.exists({ referralCode: code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique referral code');
}
