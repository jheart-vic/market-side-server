// Platform-wide enums and defaults. Referenced by models, services, and validation
// schemas so string literals live in exactly one place.

export const WALLET_CURRENCIES = ['NGN', 'USDT', 'BTC', 'ETH'];

// Assets tradable against NGN (BNB is tradable but has no wallet — positions live in trades)
export const TRADE_ASSETS = ['BTC', 'ETH', 'USDT', 'BNB'];
export const TRADE_PAIRS = TRADE_ASSETS.map((a) => `${a}/NGN`);

export const ROLES = ['user', 'admin', 'superadmin'];

export const ACCOUNT_STATUS = ['active', 'frozen'];

export const KYC_STATUS = ['unverified', 'pending', 'approved', 'rejected'];

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
  'admin_adjustment',
];

export const SIGNAL_DIRECTIONS = ['buy', 'sell'];
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
  'admin_adjustment',
  'announcement',
  'login_alert',
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
};
export const CSRF_HEADER = 'x-csrf-token';
