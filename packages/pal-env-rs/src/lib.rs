//! Rust side of the Lantern→PAL env compat contract (ADR 0032).
//!
//! `var("ENV")` reads `PAL_ENV`, falling back to `LANTERN_ENV`. Read-only on
//! purpose: `std::env::set_var` is `unsafe` in edition 2024 (racy once threads
//! exist), so Rust services read through this instead of mirroring the env.

use std::env::VarError;

/// `PAL_<suffix>` if set (even if empty — PAL wins, matching the Go/TS
/// bridges), else `LANTERN_<suffix>`. Same error contract as `std::env::var`.
pub fn var(suffix: &str) -> Result<String, VarError> {
    var_from(suffix, |k| std::env::var(k))
}

fn var_from(
    suffix: &str,
    get: impl Fn(&str) -> Result<String, VarError>,
) -> Result<String, VarError> {
    match get(&format!("PAL_{suffix}")) {
        Err(VarError::NotPresent) => get(&format!("LANTERN_{suffix}")),
        found => found,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn pal_then_lantern() {
        type Env<'a> = &'a [(&'a str, &'a str)];
        let cases: [(Env, Option<&str>); 5] = [
            (&[], None),
            (&[("LANTERN_X", "l")], Some("l")),
            (&[("PAL_X", "p")], Some("p")),
            (&[("PAL_X", "p"), ("LANTERN_X", "l")], Some("p")),
            (&[("PAL_X", ""), ("LANTERN_X", "l")], Some("")),
        ];
        for (env, want) in cases {
            let m: HashMap<&str, &str> = env.iter().copied().collect();
            let got = var_from("X", |k| {
                m.get(k).map(|v| v.to_string()).ok_or(VarError::NotPresent)
            });
            assert_eq!(
                got,
                want.map(str::to_string).ok_or(VarError::NotPresent),
                "{env:?}"
            );
        }
    }

    #[test]
    fn reads_the_real_env() {
        assert_eq!(var("PAL_ENV_RS_SURELY_UNSET"), Err(VarError::NotPresent));
    }
}
