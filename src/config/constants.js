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

// Everything the PriceService quotes: trading assets + USDT (the deposit/
// withdrawal NGN rate) + signal-only assets like BCH
export const MARKET_ASSETS = ['BTC', 'ETH', 'USDT', 'BNB', 'BCH'];

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
  'withdrawal_pending', // admin
  'kyc_submitted', // admin
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
