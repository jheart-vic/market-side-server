// Platform-wide enums and defaults. Referenced by models, services, and validation
// schemas so string literals live in exactly one place.

export const WALLET_CURRENCIES = ['NGN', 'USDT', 'BTC', 'ETH', 'BNB'];

// The platform is dollar-denominated (client 2026-07-06): user money lives in
// the USDT wallet; NGN is only the deposit/withdrawal rail and auto-converts at
// the live USDT/NGN rate ± spread. Stakes, payouts, commissions, adjustments,
// and trades are denominated in this currency (micro-USDT smallest units).
export const PLATFORM_CURRENCY = 'USDT';

// Spot trading executes against the platform dollar (X/USDT pairs)
export const TRADE_ASSETS = ['BTC', 'ETH', 'BNB'];
export const TRADE_PAIRS = TRADE_ASSETS.map((a) => `${a}/${PLATFORM_CURRENCY}`);

// Everything the PriceService quotes for the Markets list: trading assets +
// USDT (the deposit/withdrawal NGN rate) + display-only assets. Spot trading is
// still limited to TRADE_ASSETS (adding a tradeable asset needs a wallet for
// it). Any asset the price provider can't quote is simply skipped, never fatal.
export const MARKET_ASSETS = [
  'BTC', 'ETH', 'USDT', 'BNB', 'BCH',
  'DOGE', 'LTC', 'EOS', 'FIL', 'ETC', 'TRX', 'ADA', 'DOT', 'BAT', 'IOTA', 'FLOW',
];

export const ROLES = ['user', 'admin', 'superadmin'];

export const ACCOUNT_STATUS = ['active', 'frozen'];

export const KYC_STATUS = ['unverified', 'pending', 'approved', 'rejected'];
// Accepted identity documents; a live selfie is uploaded as its own file field
export const KYC_DOC_TYPES = ['passport', 'voters_card', 'nin', 'drivers_license'];

export const DEPOSIT_STATUS = ['pending', 'success', 'failed'];
export const PAYMENT_GATEWAYS = ['paystack', 'flutterwave'];

export const WITHDRAWAL_STATUS = ['pending', 'approved', 'paid', 'rejected'];

export const TRADE_SIDES = ['buy', 'sell'];
export const TRADE_STATUS = ['filled', 'failed'];

export const LEDGER_DIRECTIONS = ['credit', 'debit'];
export const LEDGER_TYPES = [
  'deposit',
  'withdrawal',
  'withdrawal_hold',
  'withdrawal_release', // refund of a hold on rejection
  'trade',
  'conversion',
  'fee',
  'signal_stake',
  'signal_settlement',
  'referral_commission',
  'spin_reward',
  'admin_adjustment',
];

// Contract-order (binary options) signals: CALL = price up, PUT = price down.
// Signal pairs are quoted vs NGN and include assets beyond the trading set
// (USDT-quoted pairs may be added later — client 2026-07-05); stakes are in
// PLATFORM_CURRENCY.
export const SIGNAL_ASSETS = ['BTC', 'ETH', 'BNB', 'BCH'];
export const SIGNAL_PAIRS = SIGNAL_ASSETS.map((a) => `${a}/NGN`);
export const SIGNAL_DIRECTIONS = ['call', 'put'];
export const SIGNAL_OUTCOMES = ['win', 'lose']; // no tie: unchanged price = lose
export const SIGNAL_STATUS = ['scheduled', 'released', 'settled', 'cancelled'];
export const SIGNAL_POSITION_STATUS = ['open', 'settled', 'cancelled'];

// Daily release window, Africa/Lagos wall-clock hours [start, end)
export const SIGNAL_WINDOW = { startHour: 15, endHour: 17 };
export const LAGOS_TZ = 'Africa/Lagos';

export const REFERRAL_LEVELS = 3;
// Defaults; admin-configurable at runtime (percent of the qualifying amount per level)
export const DEFAULT_REFERRAL_RATES = { 1: 10, 2: 2, 3: 1 };
export const REFERRAL_EVENTS = ['deposit', 'trade_fee'];

// --- Salary (referral tier rewards) ---------------------------------------
// A member is "qualified" (non-intern) when, live: cumulative deposits ≥ this,
// cumulative trade volume (signal + spot) ≥ this, AND current USD balance ≥ this
// (dollars — the service converts to micro-USDT via CURRENCY_DECIMALS.USDT).
// Dropping below the balance floor downgrades a member back to intern.
export const SALARY_QUALIFY_USD = 50;

// Membership badge ladder (low → high). "intern" = below the bar; "member" =
// qualified but under 6 valid directs; tier0…tier5 track SALARY_TIERS.
export const SALARY_BADGES = ['intern', 'member', 'tier0', 'tier1', 'tier2', 'tier3', 'tier4', 'tier5'];

// Ordered tiers: number of valid DIRECT (L1) qualified invitees → a one-time
// reward. Fulfilled manually (user contacts customer care); no auto-credit.
export const SALARY_TIERS = [
  { tier: 0, invitees: 6, reward: '$50', rewardType: 'cash' },
  { tier: 1, invitees: 15, reward: '$100', rewardType: 'cash' },
  { tier: 2, invitees: 40, reward: '$200', rewardType: 'cash' },
  { tier: 3, invitees: 100, reward: 'Laptop', rewardType: 'prize' },
  { tier: 4, invitees: 400, reward: 'iPhone 17 Pro', rewardType: 'prize' },
  { tier: 5, invitees: 1000, reward: 'Senior management + $2,000/month salary', rewardType: 'salary' },
];

export const SALARY_CLAIM_STATUS = ['pending', 'fulfilled', 'rejected'];

export const NOTIFICATION_AUDIENCES = ['user', 'admin'];
export const NOTIFICATION_TYPES = [
  'deposit_confirmed',
  'withdrawal_status',
  'signal_released',
  'signal_settled',
  'referral_commission',
  'spin_reward', // spin prize won / spin credit earned
  'admin_adjustment',
  'announcement',
  'login_alert',
  'kyc_status', // user: KYC approved/rejected
  'salary_levelup', // user: reached a new salary tier
  'salary_claim_status', // user: reward claim fulfilled/rejected
  'withdrawal_pending', // admin
  'kyc_submitted', // admin
  'salary_claim', // admin: a user claimed a salary reward
  'fraud_flag', // admin
];

export const CAPTCHA_PURPOSES = ['register', 'login', 'password_reset'];

// Auth cookies (httpOnly except csrf, which the frontend must read and echo
// back in the CSRF_HEADER on mutating requests — double-submit pattern)
export const COOKIES = {
  access: 'ms_access',
  refresh: 'ms_refresh',
  csrf: 'ms_csrf',
  // Multi-account switcher: signed httpOnly cookie holding the *inactive* linked
  // accounts (refresh token + label) plus a pointer to the active one. Absent for
  // single-account users, so nothing changes for them.
  accounts: 'ms_accounts',
};

// Max accounts a single browser may keep signed in at once (multi-account switch).
export const MAX_LINKED_ACCOUNTS = 5;
export const CSRF_HEADER = 'x-csrf-token';
