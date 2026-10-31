//! Workload image admission policy (ADR 0044).
//!
//! The runtime-manager is the only component that launches workloads
//! (invariant #1), so it is the one place every image reference passes through
//! before a registry pull — k8s pod image, docker/kata container image. It
//! does NOT verify cosign signatures itself: signature + identity verification
//! is the cluster admission layer (Kyverno `verifyImages`,
//! `infra/k8s/supply-chain/`), which sees the exact digest the kubelet pulls.
//! What this gate guarantees is the precondition that makes that admission
//! check meaningful:
//!
//! * **Digest pinning** — the reference must name immutable content
//!   (`repo@sha256:<64 hex>` or a bare `sha256:<64 hex>` bundle digest that
//!   resolves to the operator's `AGENT_IMAGE`, which must itself be pinned). A
//!   tag can be re-pointed after verification; a digest cannot.
//! * **Repository allowlist** (optional, `PAL_IMAGE_ALLOWED_REPOS`) — keeps
//!   workloads inside the repos the admission policy and signing identities
//!   cover.
//!
//! `PAL_VERIFY_SIGNATURES` (`PAL_` alias via `pal_env`): `on` | `off`;
//! default ON when `PAL_ENV` is prod/production/staging, OFF otherwise.
//! An explicit `off` in prod is honoured (documented migration valve) but
//! logged at ERROR on every start. An unparseable value fails closed.
//!
//! Firecracker and wasm do not pull OCI images: Firecracker boots operator
//! rootfs/kernel files governed by the measurement gate (ADR 0031); wasm loads
//! a node-local module. The gate applies to the image-pulling backends only.

use std::sync::OnceLock;

/// Backends whose `ScheduleRequest.image` / `AGENT_IMAGE` is a registry pull.
const IMAGE_PULLING_BACKENDS: [&str; 3] = ["k8s", "docker", "kata"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImagePolicy {
    pub enforce: bool,
    /// Repository prefixes (`ghcr.io/acme`, `registry.example.com/team/app`).
    /// Empty = any repository (signature scope is then the admission policy's).
    pub allowed_repos: Vec<String>,
}

impl ImagePolicy {
    /// Parse from raw values (pure, for tests and `from_env`).
    pub fn parse(verify: Option<&str>, allowed: Option<&str>, prod: bool) -> Result<Self, String> {
        let enforce = match verify.map(|v| v.trim().to_ascii_lowercase()) {
            None => prod,
            Some(v) if v.is_empty() => prod,
            Some(v) => match v.as_str() {
                "1" | "true" | "on" | "yes" | "enforce" => true,
                "0" | "false" | "off" | "no" => false,
                other => {
                    return Err(format!(
                        "PAL_VERIFY_SIGNATURES={other:?} is not on/off; refusing to guess"
                    ));
                }
            },
        };
        let allowed_repos = allowed
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if let Some(bad) = allowed_repos
            .iter()
            .find(|r| r.contains(['*', '@', ' ']) || r.starts_with("sha256:"))
        {
            return Err(format!(
                "PAL_IMAGE_ALLOWED_REPOS entry {bad:?} must be a plain repository prefix"
            ));
        }
        Ok(Self {
            enforce,
            allowed_repos,
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::parse(
            std::env::var("PAL_VERIFY_SIGNATURES").ok().as_deref(),
            std::env::var("PAL_IMAGE_ALLOWED_REPOS").ok().as_deref(),
            crate::tls::is_prod_env(),
        )
    }

    /// Admit (or refuse) the image a backend is about to pull. `image` is the
    /// request's reference; empty or a bare `sha256:` bundle digest means the
    /// backend falls back to `agent_image`, which is then what gets checked.
    pub fn check(&self, backend: &str, image: &str, agent_image: &str) -> Result<(), String> {
        if !self.enforce || !IMAGE_PULLING_BACKENDS.contains(&backend) {
            return Ok(());
        }
        let (effective, source) = if image.is_empty() || image.starts_with("sha256:") {
            if !image.is_empty() && !is_sha256_digest(image) {
                return Err(format!("bundle digest {image:?} is not sha256:<64 hex>"));
            }
            (agent_image, "AGENT_IMAGE")
        } else {
            (image, "workload image")
        };
        let repo = pinned_repo(effective).ok_or_else(|| {
            format!(
                "{source} {effective:?} is not digest-pinned (want repo@sha256:<64 hex>); \
                 PAL_VERIFY_SIGNATURES is on, tags are refused"
            )
        })?;
        if !self.allowed_repos.is_empty()
            && !self
                .allowed_repos
                .iter()
                .any(|p| repo == p || repo.starts_with(&format!("{p}/")))
        {
            return Err(format!(
                "{source} repository {repo:?} is not in PAL_IMAGE_ALLOWED_REPOS"
            ));
        }
        Ok(())
    }
}

static POLICY: OnceLock<(ImagePolicy, String)> = OnceLock::new();

/// Install the startup-validated policy plus the operator `AGENT_IMAGE` that a
/// bare bundle digest resolves to. Called once from `main`.
pub fn install(policy: ImagePolicy, agent_image: String) {
    let _ = POLICY.set((policy, agent_image));
}

/// Admit `image` for `backend` under the installed policy. Never installed
/// (tests, embedders) → read the env now; an unparseable value fails closed.
pub fn admit(backend: &str, image: &str) -> Result<(), String> {
    let (policy, agent_image) = POLICY.get_or_init(|| {
        let p = ImagePolicy::from_env().unwrap_or(ImagePolicy {
            enforce: true,
            allowed_repos: Vec::new(),
        });
        (p, String::new())
    });
    policy.check(backend, image, agent_image)
}

fn is_sha256_digest(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// `repo[:tag]@sha256:<64 hex>` → `repo` (tag stripped). `None` if unpinned.
fn pinned_repo(image: &str) -> Option<&str> {
    let (name, digest) = image.split_once('@')?;
    if name.is_empty() || name.contains(char::is_whitespace) || !is_sha256_digest(digest) {
        return None;
    }
    // A tag lives after the last ':' of the last path segment (a ':' earlier
    // is a registry port).
    let last_slash = name.rfind('/').map_or(0, |i| i + 1);
    Some(match name[last_slash..].find(':') {
        Some(i) => &name[..last_slash + i],
        None => name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000001";

    fn on(allowed: &str) -> ImagePolicy {
        ImagePolicy::parse(Some("on"), Some(allowed), false).unwrap()
    }

    // Regression: from_env once passed the bare suffix to pal_env, so neither
    // PAL_ nor PAL_ names were ever read. Only the allowlist var is set
    // here — `enforce` is untouched, so a concurrent lazy `admit()` init in
    // another test cannot change behaviour.
    #[test]
    fn from_env_reads_pal_and_pal_names() {
        // SAFETY: no other test reads or writes these two variables' values in a
        // way that affects its outcome (see comment above).
        unsafe { std::env::set_var("PAL_IMAGE_ALLOWED_REPOS", "ghcr.io/legacy") };
        assert_eq!(
            ImagePolicy::from_env().unwrap().allowed_repos,
            ["ghcr.io/legacy"]
        );
        unsafe { std::env::set_var("PAL_IMAGE_ALLOWED_REPOS", "ghcr.io/pal") };
        assert_eq!(
            ImagePolicy::from_env().unwrap().allowed_repos,
            ["ghcr.io/pal"]
        );
        unsafe {
            std::env::remove_var("PAL_IMAGE_ALLOWED_REPOS");
            std::env::remove_var("PAL_IMAGE_ALLOWED_REPOS");
        }
    }

    #[test]
    fn default_follows_prod() {
        assert!(ImagePolicy::parse(None, None, true).unwrap().enforce);
        assert!(!ImagePolicy::parse(None, None, false).unwrap().enforce);
        assert!(ImagePolicy::parse(Some(""), None, true).unwrap().enforce);
        assert!(!ImagePolicy::parse(Some("off"), None, true).unwrap().enforce);
        assert!(ImagePolicy::parse(Some("garbage"), None, true).is_err());
        assert!(ImagePolicy::parse(Some("on"), Some("ghcr.io/*"), true).is_err());
    }

    #[test]
    fn pinned_images_pass() {
        let p = on("");
        let pinned = format!("ghcr.io/acme/agent@{D}");
        assert!(p.check("k8s", &pinned, "").is_ok());
        let tag_and_digest = format!("localhost:5000/acme/agent:v1@{D}");
        assert!(p.check("docker", &tag_and_digest, "").is_ok());
    }

    #[test]
    fn tags_and_malformed_digests_are_refused() {
        let p = on("");
        for bad in [
            "python:3.11-slim",
            "ghcr.io/acme/agent:latest",
            "ghcr.io/acme/agent@sha256:abc",
            "ghcr.io/acme/agent@sha512:00",
            &format!("@{D}"),
            &format!("ghcr.io/acme/agent@{}", D.to_uppercase()),
        ] {
            assert!(p.check("k8s", bad, "").is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn bare_digest_checks_the_agent_image() {
        let p = on("");
        let pinned = format!("ghcr.io/acme/runner@{D}");
        assert!(p.check("k8s", D, &pinned).is_ok());
        assert!(p.check("k8s", "", &pinned).is_ok());
        assert!(
            p.check("k8s", D, "ghcr.io/pal/agent-runner:latest")
                .is_err()
        );
        assert!(p.check("k8s", "sha256:nothex", &pinned).is_err());
    }

    #[test]
    fn allowlist_is_a_path_prefix_not_a_string_prefix() {
        let p = on("ghcr.io/acme/, registry.example.com:5000/team");
        assert!(
            p.check("k8s", &format!("ghcr.io/acme/agent@{D}"), "")
                .is_ok()
        );
        assert!(
            p.check(
                "k8s",
                &format!("registry.example.com:5000/team/a:v2@{D}"),
                ""
            )
            .is_ok()
        );
        assert!(
            p.check("k8s", &format!("ghcr.io/acme-evil/agent@{D}"), "")
                .is_err()
        );
        assert!(
            p.check("k8s", &format!("docker.io/library/python@{D}"), "")
                .is_err()
        );
    }

    #[test]
    fn off_or_non_pulling_backends_are_untouched() {
        let off = ImagePolicy::parse(Some("off"), None, true).unwrap();
        assert!(off.check("k8s", "python:3.11-slim", "").is_ok());
        let p = on("");
        assert!(p.check("firecracker", "anything", "").is_ok());
        assert!(p.check("wasm", "file:///m.wasm", "").is_ok());
    }
}
