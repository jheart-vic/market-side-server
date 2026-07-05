// TradeService (SPEC §2.6) — instant buy/sell vs NGN against the internal
// ledger at the cached price (PriceService), fee applied, both legs written via
// LedgerService in one transaction. Realized P/L computed on sells (FIFO);
// unrealized P/L from open positions + current prices feeds the dashboard.
//
// Planned API:
//   executeTrade(user, { pair, side, amount })   → Trade (+ ledger group)
//   getHistory(user, { pair?, pagination })
//   getPnl(user)                                 → { realized, unrealized, total }
