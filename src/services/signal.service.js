// SignalService (SPEC §2.7) — admin-published fixed-return signals.
// Release job publishes scheduled signals daily within 15:00–17:00 Africa/Lagos
// (utils/time.isWithinSignalWindow); joining stakes NGN via LedgerService.hold —
// unique (user, signal) index enforces one join per user; settlement job sweeps
// positions with settlesAt <= now and credits stake + fixed return.
//
// Planned API:
//   createSignal(admin, data) / updateSignal / cancelSignal        (+ audit log)
//   releaseDueSignals()                → job: scheduled → released (+ notifications)
//   listActive() / listForDay(dayKey)
//   joinSignal(user, signalId, stake)  → SignalPosition | throws ALREADY_JOINED / stake bounds
//   settleDuePositions()               → job: open → settled, payout via ledger (+ notifications)
//   getPositions(user, pagination)     → "contract order" history
