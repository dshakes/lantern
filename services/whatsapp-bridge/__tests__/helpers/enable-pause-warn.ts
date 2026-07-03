// Side-effect import: must be evaluated BEFORE ../src/session.js so the
// module-load-time `PAUSE_WARN_ENABLED` const sees the flag. The pause-expiry
// warning is opt-in in prod (owner found it noisy); the ticker tests assert
// the opt-in behavior.
process.env.LANTERN_PAUSE_WARN = "1";
