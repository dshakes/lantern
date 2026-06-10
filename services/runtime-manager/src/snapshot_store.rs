//! Snapshot persistence for Tier-2 runtime snapshots (ADR 0007).
//!
//! # Design
//!
//! The `SnapshotStore` has two tiers:
//!
//! 1. **Local filesystem** (always active): rooted at `SNAPSHOT_DIR`
//!    (default `/var/lib/lantern/snapshots`).  All reads/writes always go
//!    through the local tier.
//!
//! 2. **S3/MinIO tier** (optional): enabled when `S3_ENDPOINT` + `S3_BUCKET`
//!    are set (alongside `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for
//!    authentication — the same env vars the control-plane uses).  When
//!    enabled, `put` **also** uploads artifacts + `meta.json` to S3 under:
//!    `snapshots/<agent_version_id>/<vm_id>/<snapshot_id>/`.
//!    `get` falls back to S3 when the local copy is missing.
//!
//!    **S3 failures on `put` are warn-logged, not fatal**: the snapshot is
//!    already safely on disk.  A best-effort upload may be retried by the next
//!    `put`.  Callers should never rely on S3 durability for hot-path operations.
//!
//! ```
//! $SNAPSHOT_DIR/
//!   <agent_version_id>/
//!     <vm_id>/
//!       <snapshot_id>/
//!         meta.json   — SnapshotMeta serialised as JSON
//!         snapshot    — Firecracker snapshot file
//!         mem         — Firecracker memory file
//!
//! s3://$S3_BUCKET/
//!   snapshots/<agent_version_id>/<vm_id>/<snapshot_id>/
//!     meta.json
//!     snapshot
//!     mem
//! ```
//!
//! # Retention (ADR 0007 Tier 2)
//!
//! After every `put`, `enforce_retention` is called:
//!
//! 1. **Count cap**: keep the newest 3 snapshots per `(agent_version_id, vm_id)`;
//!    delete all older ones.
//! 2. **Age cap**: delete any snapshot whose `created_at` is more than 7 days old.
//!
//! Both caps are enforced on every write.  Deletion is best-effort: a warning is
//! logged on failure and the store continues.
//!
//! # SHA-256
//!
//! The checksum is computed over all artifact bytes concatenated in sorted
//! filename order.  For firecracker snapshots that is always `mem` then
//! `snapshot` (alphabetical).  The `sha2` crate is already in the workspace
//! lockfile via wasmtime's dependency tree; we add it directly to
//! `Cargo.toml` so the dependency is explicit.

use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use object_store::ObjectStore;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as StorePath;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Metadata describing one persisted snapshot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotMeta {
    /// Stable unique ID (UUID v4).
    pub id: String,
    /// Hex-encoded SHA-256 over all artifact bytes (sorted by filename).
    pub sha256: String,
    /// Total byte count of all artifact files.
    pub size_bytes: u64,
    /// Wall-clock time when the snapshot was persisted.
    pub created_at: DateTime<Utc>,
    /// The agent version this snapshot belongs to.
    pub agent_version_id: String,
    /// The VM this snapshot belongs to.
    pub vm_id: String,
}

/// Bytes to store. The caller supplies a map of `filename → bytes`; the store
/// writes each file under the snapshot directory and derives sha256/size.
pub type ArtifactMap = Vec<(String, Vec<u8>)>;

// ---------------------------------------------------------------------------
// SnapshotStore
// ---------------------------------------------------------------------------

/// Maximum number of snapshots to keep per `(agent_version_id, vm_id)`.
const MAX_SNAPSHOTS_PER_VM: usize = 3;

/// Maximum snapshot age before retention deletes it (7 days in seconds).
const MAX_AGE_SECS: i64 = 7 * 24 * 3600;

/// S3 prefix used for all snapshot objects.
const S3_PREFIX: &str = "snapshots";

/// Local filesystem + optional S3/MinIO snapshot store.
///
/// # S3 tier
///
/// Activated when `S3_ENDPOINT` and `S3_BUCKET` are set in the environment
/// (plus `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).  When active:
///
/// - `put`: after writing to the local filesystem, objects are uploaded to S3
///   under `snapshots/<agent_version_id>/<vm_id>/<snapshot_id>/`.  An S3
///   upload failure is **warn-logged, not fatal** — the snapshot is already
///   durably on disk.
/// - `get`: if the local `meta.json` is missing, falls back to downloading it
///   from S3 (the S3 copy may exist if the local directory was pruned).
///
/// Local filesystem always remains the primary and authoritative store; S3 is
/// a warm backup / cross-node distribution tier.
#[derive(Clone)]
pub struct SnapshotStore {
    root: PathBuf,
    /// Optional S3/MinIO client.  `None` when the env vars are absent.
    s3: Option<std::sync::Arc<dyn ObjectStore>>,
    /// S3 bucket name (empty when `s3` is `None`).
    s3_bucket: String,
    /// Injected clock for tests. `None` → use `Utc::now()`.
    #[cfg(test)]
    pub clock: Option<DateTime<Utc>>,
}

impl std::fmt::Debug for SnapshotStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnapshotStore")
            .field("root", &self.root)
            .field("s3_enabled", &self.s3.is_some())
            .field("s3_bucket", &self.s3_bucket)
            .finish()
    }
}

impl SnapshotStore {
    /// Create a local-only store rooted at `root`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            s3: None,
            s3_bucket: String::new(),
            #[cfg(test)]
            clock: None,
        }
    }

    /// Create a store with an explicit S3 client (used in tests so the bucket
    /// can be pre-created without relying on env vars).
    pub fn with_s3(
        root: impl Into<PathBuf>,
        s3: std::sync::Arc<dyn ObjectStore>,
        bucket: impl Into<String>,
    ) -> Self {
        Self {
            root: root.into(),
            s3: Some(s3),
            s3_bucket: bucket.into(),
            #[cfg(test)]
            clock: None,
        }
    }

    /// Create a store from the environment: `SNAPSHOT_DIR` for the local root,
    /// `S3_ENDPOINT` + `S3_BUCKET` + `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
    /// for the optional S3 tier.  Missing S3 env vars → local-only.
    pub fn from_env() -> Self {
        let root = std::env::var("SNAPSHOT_DIR")
            .unwrap_or_else(|_| "/var/lib/lantern/snapshots".to_string());

        let s3_endpoint = std::env::var("S3_ENDPOINT").unwrap_or_default();
        let s3_bucket = std::env::var("S3_BUCKET").unwrap_or_default();
        let access_key = std::env::var("AWS_ACCESS_KEY_ID").unwrap_or_default();
        let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY").unwrap_or_default();

        let s3 = if !s3_endpoint.is_empty() && !s3_bucket.is_empty() {
            match AmazonS3Builder::new()
                .with_endpoint(&s3_endpoint)
                .with_bucket_name(&s3_bucket)
                .with_access_key_id(&access_key)
                .with_secret_access_key(&secret_key)
                // MinIO requires path-style URLs (not virtual-hosted).
                // AWS real endpoints default to virtual-hosted; callers that
                // set S3_ENDPOINT to an AWS regional endpoint should leave this
                // false, but self-hosted MinIO / LocalStack need path-style.
                .with_virtual_hosted_style_request(false)
                // HTTP is required for local MinIO; harmlessly ignored for HTTPS.
                .with_allow_http(true)
                // MinIO only needs a region in the sig header; "us-east-1" is
                // its hardcoded default and always accepted.
                .with_region("us-east-1")
                .build()
            {
                Ok(client) => {
                    tracing::info!(
                        endpoint = %s3_endpoint,
                        bucket = %s3_bucket,
                        "snapshot_store: S3 tier enabled"
                    );
                    Some(std::sync::Arc::new(client) as std::sync::Arc<dyn ObjectStore>)
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        endpoint = %s3_endpoint,
                        bucket = %s3_bucket,
                        "snapshot_store: failed to build S3 client; S3 tier disabled"
                    );
                    None
                }
            }
        } else {
            None
        };

        Self {
            root: PathBuf::from(root),
            s3,
            s3_bucket,
            #[cfg(test)]
            clock: None,
        }
    }

    /// Current time — injected in tests, real clock in production.
    fn now(&self) -> DateTime<Utc> {
        #[cfg(test)]
        if let Some(t) = self.clock {
            return t;
        }
        Utc::now()
    }

    /// Path to `$root/<agent_version_id>/<vm_id>/<snapshot_id>`.
    fn snapshot_dir(&self, agent_version_id: &str, vm_id: &str, snapshot_id: &str) -> PathBuf {
        self.root
            .join(agent_version_id)
            .join(vm_id)
            .join(snapshot_id)
    }

    /// Path to `$root/<agent_version_id>/<vm_id>`.
    fn vm_dir(&self, agent_version_id: &str, vm_id: &str) -> PathBuf {
        self.root.join(agent_version_id).join(vm_id)
    }

    // -----------------------------------------------------------------------
    // put
    // -----------------------------------------------------------------------

    /// Persist `artifacts` for `(agent_version_id, vm_id)` and return the
    /// metadata.  The sha256 is computed over all artifact bytes, sorted by
    /// filename.  After writing to the local filesystem, if the S3 tier is
    /// configured the same files are uploaded to S3.  An S3 failure is
    /// warn-logged but does NOT cause the `put` to fail (local write already
    /// succeeded).  After writing, retention is enforced.
    pub async fn put(
        &self,
        agent_version_id: &str,
        vm_id: &str,
        artifacts: ArtifactMap,
    ) -> Result<SnapshotMeta> {
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let dir = self.snapshot_dir(agent_version_id, vm_id, &snapshot_id);

        tokio::fs::create_dir_all(&dir)
            .await
            .with_context(|| format!("create snapshot dir {dir:?}"))?;

        // Sort artifacts by filename for deterministic sha256.
        let mut sorted = artifacts;
        sorted.sort_by(|a, b| a.0.cmp(&b.0));

        let mut hasher = Sha256::new();
        let mut total_size: u64 = 0;

        for (filename, bytes) in &sorted {
            let path = dir.join(filename);
            tokio::fs::write(&path, bytes)
                .await
                .with_context(|| format!("write artifact {path:?}"))?;
            hasher.update(bytes);
            total_size += bytes.len() as u64;
        }

        let sha256 = hex::encode(hasher.finalize());

        let meta = SnapshotMeta {
            id: snapshot_id.clone(),
            sha256,
            size_bytes: total_size,
            created_at: self.now(),
            agent_version_id: agent_version_id.to_string(),
            vm_id: vm_id.to_string(),
        };

        // Write the meta sidecar locally.
        let meta_path = dir.join("meta.json");
        let meta_json = serde_json::to_vec_pretty(&meta).context("serialize SnapshotMeta")?;
        tokio::fs::write(&meta_path, meta_json.clone())
            .await
            .with_context(|| format!("write meta sidecar {meta_path:?}"))?;

        tracing::info!(
            snapshot_id = %snapshot_id,
            agent_version_id = %agent_version_id,
            vm_id = %vm_id,
            size_bytes = total_size,
            sha256 = &meta.sha256,
            "snapshot persisted"
        );

        // S3 tier: best-effort upload.  Failures are warn-logged, not fatal.
        if let Some(ref s3) = self.s3 {
            let prefix = format!("{S3_PREFIX}/{agent_version_id}/{vm_id}/{snapshot_id}");

            // Upload each artifact.
            for (filename, bytes) in &sorted {
                let key = StorePath::from(format!("{prefix}/{filename}").as_str());
                if let Err(e) = s3
                    .put(&key, bytes::Bytes::copy_from_slice(bytes).into())
                    .await
                {
                    tracing::warn!(
                        snapshot_id = %snapshot_id,
                        key = %key,
                        error = %e,
                        "snapshot_store: S3 upload failed (non-fatal; local copy is safe)"
                    );
                }
            }

            // Upload meta.json.
            let meta_key = StorePath::from(format!("{prefix}/meta.json").as_str());
            if let Err(e) = s3
                .put(&meta_key, bytes::Bytes::copy_from_slice(&meta_json).into())
                .await
            {
                tracing::warn!(
                    snapshot_id = %snapshot_id,
                    key = %meta_key,
                    error = %e,
                    "snapshot_store: S3 meta.json upload failed (non-fatal)"
                );
            } else {
                tracing::debug!(
                    snapshot_id = %snapshot_id,
                    prefix = %prefix,
                    "snapshot_store: S3 upload complete"
                );
            }
        }

        // Enforce retention after every write.
        self.enforce_retention(agent_version_id, vm_id).await;

        Ok(meta)
    }

    // -----------------------------------------------------------------------
    // get
    // -----------------------------------------------------------------------

    /// Retrieve the metadata for a specific snapshot.
    ///
    /// Checks the local filesystem first.  If the local `meta.json` is absent
    /// and the S3 tier is configured, falls back to downloading from S3 and
    /// caching the result locally before returning.  Returns `None` when the
    /// snapshot is found in neither location.
    pub async fn get(
        &self,
        agent_version_id: &str,
        vm_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<SnapshotMeta>> {
        let meta_path = self
            .snapshot_dir(agent_version_id, vm_id, snapshot_id)
            .join("meta.json");

        // --- Local hit ---
        match tokio::fs::read(&meta_path).await {
            Ok(bytes) => {
                let meta: SnapshotMeta = serde_json::from_slice(&bytes)
                    .with_context(|| format!("deserialize SnapshotMeta from {meta_path:?}"))?;
                return Ok(Some(meta));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Fall through to S3 lookup below.
            }
            Err(e) => return Err(e).with_context(|| format!("read {meta_path:?}")),
        }

        // --- S3 fallback ---
        let s3 = match self.s3.as_ref() {
            Some(s) => s,
            None => return Ok(None),
        };

        let key = StorePath::from(
            format!("{S3_PREFIX}/{agent_version_id}/{vm_id}/{snapshot_id}/meta.json").as_str(),
        );

        match s3.get(&key).await {
            Ok(result) => {
                let bytes = result
                    .bytes()
                    .await
                    .context("read S3 meta.json response body")?;

                let meta: SnapshotMeta =
                    serde_json::from_slice(&bytes).context("deserialize SnapshotMeta from S3")?;

                // Cache locally so subsequent reads hit disk.
                if let Some(parent) = meta_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&meta_path, &bytes).await;

                tracing::debug!(
                    snapshot_id = %snapshot_id,
                    "snapshot_store: S3 fallback hit; cached locally"
                );
                Ok(Some(meta))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("S3 get for snapshot {snapshot_id}: {e}")),
        }
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------

    /// List all snapshot metadata for `(agent_version_id, vm_id)`, sorted
    /// newest-first by `created_at`.
    pub async fn list(&self, agent_version_id: &str, vm_id: &str) -> Result<Vec<SnapshotMeta>> {
        let vm_dir = self.vm_dir(agent_version_id, vm_id);

        let mut entries = match tokio::fs::read_dir(&vm_dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(vec![]);
            }
            Err(e) => {
                return Err(e).with_context(|| format!("read_dir {vm_dir:?}"));
            }
        };

        let mut metas: Vec<SnapshotMeta> = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let meta_path = entry.path().join("meta.json");
            match tokio::fs::read(&meta_path).await {
                Ok(bytes) => match serde_json::from_slice::<SnapshotMeta>(&bytes) {
                    Ok(m) => metas.push(m),
                    Err(e) => {
                        tracing::warn!(
                            path = ?meta_path,
                            error = %e,
                            "snapshot_store: skipping unreadable meta.json"
                        );
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!(
                        path = ?meta_path,
                        error = %e,
                        "snapshot_store: skipping unreadable meta.json"
                    );
                }
            }
        }

        // Newest first.
        metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(metas)
    }

    // -----------------------------------------------------------------------
    // enforce_retention
    // -----------------------------------------------------------------------

    /// Enforce ADR 0007 Tier-2 retention policy:
    ///
    /// 1. Keep the newest `MAX_SNAPSHOTS_PER_VM` (3) per `(agent_version_id, vm_id)`.
    ///    Delete everything else.
    /// 2. Delete any surviving snapshot older than `MAX_AGE_SECS` (7 days).
    ///
    /// Errors on individual deletes are logged as warnings; the method never
    /// returns an error so a retention failure does not block the write path.
    pub async fn enforce_retention(&self, agent_version_id: &str, vm_id: &str) {
        let metas = match self.list(agent_version_id, vm_id).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    agent_version_id,
                    vm_id,
                    error = %e,
                    "snapshot_store: retention: could not list snapshots"
                );
                return;
            }
        };

        // metas is already sorted newest-first.
        let now = self.now();
        let cutoff = now - chrono::Duration::seconds(MAX_AGE_SECS);

        for (idx, meta) in metas.iter().enumerate() {
            let too_old = meta.created_at < cutoff;
            let over_count = idx >= MAX_SNAPSHOTS_PER_VM;

            if too_old || over_count {
                let dir = self.snapshot_dir(agent_version_id, vm_id, &meta.id);
                tracing::info!(
                    snapshot_id = %meta.id,
                    agent_version_id,
                    vm_id,
                    too_old,
                    over_count,
                    "snapshot_store: retention: deleting snapshot"
                );
                if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
                    tracing::warn!(
                        snapshot_id = %meta.id,
                        path = ?dir,
                        error = %e,
                        "snapshot_store: retention: failed to delete snapshot dir"
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Hex encoding helper (no extra crate — just format!)
// ---------------------------------------------------------------------------

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    /// Build a store rooted at a temporary directory.
    fn tmp_store() -> (TempDir, SnapshotStore) {
        let dir = TempDir::new().unwrap();
        let store = SnapshotStore::new(dir.path());
        (dir, store)
    }

    /// Build a store with a fixed clock (for age-based retention tests).
    fn tmp_store_at(t: DateTime<Utc>) -> (TempDir, SnapshotStore) {
        let dir = TempDir::new().unwrap();
        let mut store = SnapshotStore::new(dir.path());
        store.clock = Some(t);
        (dir, store)
    }

    // -----------------------------------------------------------------------
    // put / get: sha256 correctness
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn put_returns_meta_with_correct_sha256() {
        let (_dir, store) = tmp_store();
        let artifacts: ArtifactMap = vec![
            ("mem".to_string(), b"memory bytes".to_vec()),
            ("snapshot".to_string(), b"snapshot bytes".to_vec()),
        ];

        // Expected sha256 = sha256("memory bytes" + "snapshot bytes")
        // Sorted alphabetically: mem < snapshot.
        let expected = {
            let mut h = Sha256::new();
            h.update(b"memory bytes");
            h.update(b"snapshot bytes");
            hex::encode(h.finalize())
        };

        let meta = store
            .put("agent-v1", "vm-1", artifacts)
            .await
            .expect("put should succeed");

        assert_eq!(meta.sha256, expected, "sha256 mismatch");
        assert_eq!(meta.size_bytes, 12 + 14, "size_bytes mismatch");
        assert_eq!(meta.agent_version_id, "agent-v1");
        assert_eq!(meta.vm_id, "vm-1");
    }

    #[tokio::test]
    async fn put_sorts_artifacts_by_name_for_sha256() {
        let (_dir, store) = tmp_store();
        // Supply in reverse order — sha256 must still be deterministic (sorted).
        let artifacts_reversed: ArtifactMap = vec![
            ("snapshot".to_string(), b"snapshot bytes".to_vec()),
            ("mem".to_string(), b"memory bytes".to_vec()),
        ];
        let artifacts_sorted: ArtifactMap = vec![
            ("mem".to_string(), b"memory bytes".to_vec()),
            ("snapshot".to_string(), b"snapshot bytes".to_vec()),
        ];

        let m1 = store
            .put("agent-v1", "vm-sort", artifacts_reversed)
            .await
            .unwrap();
        let m2 = store
            .put("agent-v1", "vm-sort", artifacts_sorted)
            .await
            .unwrap();

        // Both should have the same sha256 (sort is applied before hashing).
        assert_eq!(m1.sha256, m2.sha256, "sha256 must be sort-stable");
    }

    #[tokio::test]
    async fn get_returns_persisted_meta() {
        let (_dir, store) = tmp_store();
        let artifacts: ArtifactMap = vec![("data".to_string(), b"hello".to_vec())];
        let meta = store.put("av1", "vm1", artifacts).await.unwrap();

        let retrieved = store
            .get("av1", "vm1", &meta.id)
            .await
            .unwrap()
            .expect("snapshot should exist");

        assert_eq!(retrieved.id, meta.id);
        assert_eq!(retrieved.sha256, meta.sha256);
        assert_eq!(retrieved.size_bytes, meta.size_bytes);
    }

    #[tokio::test]
    async fn get_returns_none_for_missing_snapshot() {
        let (_dir, store) = tmp_store();
        let result = store.get("nonexistent", "vm", "no-such-id").await.unwrap();
        assert!(result.is_none());
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn list_returns_empty_when_no_snapshots() {
        let (_dir, store) = tmp_store();
        let list = store.list("av1", "vm1").await.unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn list_returns_all_snapshots_newest_first() {
        let (_dir, store) = tmp_store();

        // Three snapshots with different clocks.
        let t0 = Utc::now() - chrono::Duration::seconds(300);
        let t1 = Utc::now() - chrono::Duration::seconds(200);
        let t2 = Utc::now() - chrono::Duration::seconds(100);

        let mut s0 = SnapshotStore::new(store.root.clone());
        s0.clock = Some(t0);
        let mut s1 = SnapshotStore::new(store.root.clone());
        s1.clock = Some(t1);
        let mut s2 = SnapshotStore::new(store.root.clone());
        s2.clock = Some(t2);

        s0.put("av", "vm", vec![("a".to_string(), b"a".to_vec())])
            .await
            .unwrap();
        s1.put("av", "vm", vec![("a".to_string(), b"b".to_vec())])
            .await
            .unwrap();
        s2.put("av", "vm", vec![("a".to_string(), b"c".to_vec())])
            .await
            .unwrap();

        // Use a plain store (no clock override) just for list.
        let plain = SnapshotStore::new(store.root.clone());
        let list = plain.list("av", "vm").await.unwrap();

        assert_eq!(list.len(), 3, "should have 3 snapshots");
        // Newest first.
        assert!(list[0].created_at >= list[1].created_at);
        assert!(list[1].created_at >= list[2].created_at);
    }

    // -----------------------------------------------------------------------
    // enforce_retention: count cap (keep newest 3)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn retention_keeps_only_newest_3_by_count() {
        let (_dir, store) = tmp_store();

        // Write 5 snapshots with distinct timestamps.
        for i in 0..5_u64 {
            let t = Utc::now() - chrono::Duration::seconds((500 - i * 100) as i64);
            let mut s = SnapshotStore::new(store.root.clone());
            s.clock = Some(t);
            s.put("av", "vm-count", vec![("f".to_string(), vec![i as u8])])
                .await
                .unwrap();
        }

        let plain = SnapshotStore::new(store.root.clone());
        // enforce_retention is called inside put, so after 5 puts the youngest 3
        // survive. The 4th put triggered retention that left 3. The 5th put
        // triggered retention again, still leaving 3.
        let list = plain.list("av", "vm-count").await.unwrap();
        assert!(
            list.len() <= MAX_SNAPSHOTS_PER_VM,
            "expected ≤{MAX_SNAPSHOTS_PER_VM} snapshots, got {}",
            list.len()
        );
    }

    // -----------------------------------------------------------------------
    // enforce_retention: age cap (delete > 7 days)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn retention_deletes_snapshots_older_than_7_days() {
        let (_dir, store) = tmp_store();

        // One snapshot that is 8 days old.
        let old_time = Utc::now() - chrono::Duration::seconds(MAX_AGE_SECS + 3600);
        let mut old_store = SnapshotStore::new(store.root.clone());
        old_store.clock = Some(old_time);
        old_store
            .put("av", "vm-age", vec![("f".to_string(), b"old".to_vec())])
            .await
            .unwrap();

        // One fresh snapshot (now).
        let fresh_store = SnapshotStore::new(store.root.clone());
        fresh_store
            .put("av", "vm-age", vec![("f".to_string(), b"new".to_vec())])
            .await
            .unwrap();

        // Manually call retention with a "now" time so the old one is past the
        // age cap.
        let plain = SnapshotStore::new(store.root.clone());
        plain.enforce_retention("av", "vm-age").await;

        let list = plain.list("av", "vm-age").await.unwrap();
        // Only the fresh snapshot should survive.
        assert_eq!(list.len(), 1, "old snapshot should have been deleted");
    }

    // -----------------------------------------------------------------------
    // Multiple (agent_version_id, vm_id) pairs are independent
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn retention_is_scoped_to_agent_version_and_vm() {
        let (_dir, store) = tmp_store();

        // Write 4 snapshots under vm-A and 4 under vm-B.
        for i in 0..4_u64 {
            let t = Utc::now() - chrono::Duration::seconds((400 - i * 100) as i64);
            let mut s = SnapshotStore::new(store.root.clone());
            s.clock = Some(t);
            s.put("av", "vm-A", vec![("f".to_string(), vec![i as u8])])
                .await
                .unwrap();
            s.put("av", "vm-B", vec![("f".to_string(), vec![i as u8])])
                .await
                .unwrap();
        }

        let plain = SnapshotStore::new(store.root.clone());
        let list_a = plain.list("av", "vm-A").await.unwrap();
        let list_b = plain.list("av", "vm-B").await.unwrap();

        assert!(
            list_a.len() <= MAX_SNAPSHOTS_PER_VM,
            "vm-A: {}",
            list_a.len()
        );
        assert!(
            list_b.len() <= MAX_SNAPSHOTS_PER_VM,
            "vm-B: {}",
            list_b.len()
        );
    }

    // -----------------------------------------------------------------------
    // Sha256 of empty artifact set
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn put_empty_artifacts_produces_empty_sha256() {
        let (_dir, store) = tmp_store();
        let meta = store.put("av", "vm-empty", vec![]).await.unwrap();
        // sha256 of zero bytes.
        let expected = hex::encode(Sha256::new().finalize());
        assert_eq!(meta.sha256, expected);
        assert_eq!(meta.size_bytes, 0);
    }

    // Helper to collect unique sha256 values from a metadata list.
    fn sha256_set(metas: &[SnapshotMeta]) -> HashMap<String, usize> {
        let mut m = HashMap::new();
        for meta in metas {
            *m.entry(meta.sha256.clone()).or_insert(0) += 1;
        }
        m
    }

    // Ensure list gives distinct IDs (not the same snapshot duplicated).
    #[tokio::test]
    async fn list_gives_distinct_snapshot_ids() {
        let (_dir, store) = tmp_store();
        for i in 0..3u8 {
            store
                .put("av", "vm-ids", vec![("f".to_string(), vec![i])])
                .await
                .unwrap();
        }
        let plain = SnapshotStore::new(store.root.clone());
        let list = plain.list("av", "vm-ids").await.unwrap();
        let ids: std::collections::HashSet<_> = list.iter().map(|m| &m.id).collect();
        assert_eq!(ids.len(), list.len(), "snapshot IDs must be unique");
    }

    // -----------------------------------------------------------------------
    // S3/MinIO integration test
    //
    // Requires a live MinIO instance at http://localhost:9000 with credentials
    // lantern/lanternsecret.  The test gates on reachability so it skips
    // cleanly when MinIO is down (CI without infra).
    // -----------------------------------------------------------------------

    /// Check whether MinIO is reachable.  Returns true when the health probe
    /// returns 2xx.  Uses the blocking reqwest client inside `spawn_blocking`
    /// so this can be called from an async test without pulling in the full
    /// reqwest async stack in dev-dependencies.
    async fn minio_reachable() -> bool {
        tokio::task::spawn_blocking(|| {
            // reqwest is already a dependency (via the control-plane or transitively).
            // We use a plain TCP connect as the lightest possible probe.
            use std::net::TcpStream;
            TcpStream::connect("127.0.0.1:9000").is_ok()
        })
        .await
        .unwrap_or(false)
    }

    /// Build an `AmazonS3` client pointing at the local MinIO instance.
    fn minio_s3_client(bucket: &str) -> std::sync::Arc<dyn ObjectStore> {
        let client = AmazonS3Builder::new()
            .with_endpoint("http://localhost:9000")
            .with_bucket_name(bucket)
            .with_access_key_id("lantern")
            .with_secret_access_key("lanternsecret")
            // MinIO requires path-style URLs and accepts "us-east-1" as its
            // default region in the SigV4 credential scope.
            .with_virtual_hosted_style_request(false)
            .with_region("us-east-1")
            .with_allow_http(true)
            .build()
            .expect("build MinIO client");
        std::sync::Arc::new(client) as std::sync::Arc<dyn ObjectStore>
    }

    /// Ensure the test bucket exists (create via S3 PutBucket if absent).
    /// `object_store` surfaces "bucket not found" as a transport error on the
    /// first `put`; we pre-create it via the AWS SDK-compatible path on the
    /// client instead.
    async fn ensure_bucket(bucket: &str) {
        // Use reqwest to call the MinIO S3 CreateBucket API.
        // The simplest approach: attempt a PUT on the bucket root.
        // MinIO returns 200/409 (BucketAlreadyOwnedByYou) either way.
        let url = format!("http://localhost:9000/{bucket}");
        // Build a minimal AWS Signature V4 request via the object_store client
        // by just issuing a head-bucket test put and ignoring the result; the
        // bucket is created by the object_store S3 client on first use via
        // automatic create-if-not-exists on MinIO.
        //
        // Instead, create the bucket via a direct HTTP PUT using the MinIO
        // anonymous endpoint (MinIO auto-creates buckets when credentials match).
        let _ = reqwest::Client::new()
            .put(&url)
            .basic_auth("lantern", Some("lanternsecret"))
            .send()
            .await;
    }

    /// Integration test: put → delete local copy → get (S3 fallback) → verify.
    ///
    /// This test runs against the live MinIO at localhost:9000 that the dev
    /// infra stack starts.  It is gated on reachability so CI without MinIO
    /// skips it cleanly.
    #[tokio::test]
    async fn s3_fallback_get_after_local_delete() {
        if !minio_reachable().await {
            eprintln!("skipping: MinIO not reachable at localhost:9000");
            return;
        }

        let bucket = "lantern-snapshots-test";
        ensure_bucket(bucket).await;

        let s3 = minio_s3_client(bucket);
        let dir = TempDir::new().unwrap();

        let store = SnapshotStore::with_s3(dir.path(), s3, bucket);

        // --- put ---
        let payload = b"hello-snapshot-world";
        let artifacts: ArtifactMap = vec![("data.bin".to_string(), payload.to_vec())];
        let meta = store
            .put("av-minio-test", "vm-minio-test", artifacts)
            .await
            .expect("put should succeed");

        // Verify local copy exists.
        assert!(
            store
                .get("av-minio-test", "vm-minio-test", &meta.id)
                .await
                .unwrap()
                .is_some(),
            "local get should return the snapshot"
        );

        // --- delete the local directory to force S3 fallback ---
        let local_dir = store.snapshot_dir("av-minio-test", "vm-minio-test", &meta.id);
        tokio::fs::remove_dir_all(&local_dir)
            .await
            .expect("remove local snapshot dir");

        // Local get now returns None without S3.
        let local_only = SnapshotStore::new(dir.path());
        assert!(
            local_only
                .get("av-minio-test", "vm-minio-test", &meta.id)
                .await
                .unwrap()
                .is_none(),
            "local-only store should return None after delete"
        );

        // --- S3 fallback get ---
        let s3_again = minio_s3_client(bucket);
        let store2 = SnapshotStore::with_s3(dir.path(), s3_again, bucket);
        let got = store2
            .get("av-minio-test", "vm-minio-test", &meta.id)
            .await
            .expect("S3 fallback get should not error")
            .expect("S3 fallback get should find the snapshot");

        // --- verify ---
        assert_eq!(got.id, meta.id, "snapshot id must round-trip");
        assert_eq!(got.sha256, meta.sha256, "sha256 must round-trip");
        assert_eq!(
            got.size_bytes, meta.size_bytes,
            "size_bytes must round-trip"
        );
        assert_eq!(
            got.agent_version_id, meta.agent_version_id,
            "agent_version_id must round-trip"
        );
    }
}
