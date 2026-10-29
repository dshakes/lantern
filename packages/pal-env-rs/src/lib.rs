//! Rust side of the Lantern→PAL env compat contract (ADR 0032).
//!
//! `var("PAL_ENV")` reads `PAL_ENV`, falling back to `LANTERN_ENV`. Read-only on
//! purpose: `std::env::set_var` is `unsafe` in edition 2024 (racy once threads
//! exist), so Rust services read through this instead of mirroring the env.

use std::env::VarError;

/// `name` (`PAL_X`) if set, else `LANTERN_X`. An EMPTY `PAL_` value counts as
/// unset when `LANTERN_` is non-empty (matching the Go/TS bridges), so a stray
/// `PAL_X=` cannot blank a credential. A name without the `PAL_` prefix is read
/// as-is. Same error contract as `std::env::var`.
pub fn var(name: &str) -> Result<String, VarError> {
    var_from(name, |k| std::env::var(k))
}

fn var_from(
    name: &str,
    get: impl Fn(&str) -> Result<String, VarError>,
) -> Result<String, VarError> {
    let Some(suffix) = name.strip_prefix("PAL_") else {
        return get(name);
    };
    let legacy = || get(&format!("LANTERN_{suffix}"));
    match get(name) {
        Err(VarError::NotPresent) => legacy(),
        Ok(v) if v.is_empty() => match legacy() {
            Ok(l) if !l.is_empty() => Ok(l),
            _ => Ok(v),
        },
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
        let cases: [(Env, Option<&str>); 7] = [
            (&[], None),
            (&[("LANTERN_X", "l")], Some("l")),
            (&[("PAL_X", "p")], Some("p")),
            (&[("PAL_X", "p"), ("LANTERN_X", "l")], Some("p")),
            // An empty PAL_ never blanks a non-empty LANTERN_.
            (&[("PAL_X", ""), ("LANTERN_X", "l")], Some("l")),
            (&[("PAL_X", ""), ("LANTERN_X", "")], Some("")),
            (&[("PAL_X", "")], Some("")),
        ];
        for (env, want) in cases {
            let m: HashMap<&str, &str> = env.iter().copied().collect();
            let got = var_from("PAL_X", |k| {
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
    fn unprefixed_name_has_no_fallback() {
        let got = var_from("X", |k| match k {
            "LANTERN_X" => Ok("l".to_string()),
            _ => Err(VarError::NotPresent),
        });
        assert_eq!(got, Err(VarError::NotPresent));
    }

    #[test]
    fn reads_the_real_env() {
        assert_eq!(var("PAL_ENV_RS_SURELY_UNSET"), Err(VarError::NotPresent));
    }
}
