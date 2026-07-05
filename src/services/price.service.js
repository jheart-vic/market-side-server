// PriceService (SPEC §2.5) — provider abstraction (CoinGecko seed; Binance/CMC
// swappable) + server-side cache. Pairs BTC/ETH/USDT/BNB vs NGN (composed from
// USD pairs + USD/NGN when needed). Feeds REST endpoints, Socket.IO price
// pushes, trade execution, and NGN↔crypto conversion (with configured spread).
//
// Planned API:
//   getPrices()                       → cached { pair, price, change24h, volume }[]
//   getPrice(pair)                    → current cached price (kobo per unit)
//   getOhlc(pair, interval, range)    → candlestick data
//   getDepth(pair)                    → market depth
//   refreshCache()                    → called by the price-refresh job
//   onPriceUpdate(cb)                 → hook for the Socket.IO gateway
