# ADR 0044 — Supply chain: signing, provenance, SBOM, and image admission

**Status:** Accepted
**Date:** 2026-10-29
**Deciders:** Platform team

---

## Context

`docs/architecture/01-overview.md` said "Signed agent bundles via cosign,
verified before scheduling", and `AGENT.md` said "the control plane verifies the
cosign signature against tenant-trusted keys before scheduling". Neither was
true. An audit on 2026-10-29 found:

- **CI.** `build-images.yml` already signed every pushed image keyless (GitHub
  OIDC → Fulcio/Rekor) by digest. There was no provenance attestation
  (`provenance: false`) and no SBOM. `release.yml` published only a source tag:
  no binaries, checksums or signatures.
- **Admission.** The data-plane chart had an opt-in Kyverno `verifyImages`
  policy for platform images, but it trusted
  `sign-images.yml@refs/heads/main`, while images are signed by
  `build-images.yml` on `master`. Turning it on would have blocked every image.
- **Platform.** There is no signed "bundle" artifact on any pull path.
  `agent_versions.digest` is `md5(name)` in every insert path and
  `bundle_uri` is a placeholder (`local://auto-created`). Real pulls are:
  1. k8s / docker / kata: the kubelet or dockerd pulls `ScheduleRequest.image`
     (from the spec's `image_digest`), or the operator `AGENT_IMAGE` when that
     field is empty or a bare `sha256:` digest. The runtime-scheduler's error
     message said "tags not allowed", but nothing enforced it.
  2. Firecracker boots operator-provisioned kernel and rootfs files. They are
     not pulled, and the measurement gate (ADR 0031) already covers them.
  3. wasm loads a module file that is local to the node.

## Decision

1. **CI signs everything it publishes, and checks its own output.**
   - `build-images.yml`, for each pushed digest:
     - keyless cosign signature, as before;
     - SLSA build-provenance attestation (`actions/attest-build-provenance`,
       pushed to the registry);
     - SPDX-JSON SBOM (syft through `anchore/sbom-action`), attached with
       `cosign attest --type spdxjson`.
     The job then verifies the signature, the SBOM attestation and the
     provenance under the expected identity. It also checks that a different
     identity fails to verify, so a verification that does not bind to the
     signer fails CI.
   - `release.yml` (`cli-artifacts` job) builds the `lantern` CLI for
     linux/darwin on amd64/arm64 and windows/amd64. It publishes `SHA256SUMS`
     with a keyless cosign bundle (`SHA256SUMS.sigstore.json`), checked before
     upload, plus SLSA provenance for every binary.
   - Every new action is pinned by SHA.
2. **The runtime-manager admits only digest-pinned images.**
   `services/runtime-manager/src/image_policy.rs` runs in `schedule()`, after
   backend selection and before any pull. This is the single chokepoint for
   Spawn and Schedule (invariant #1). When `PAL_VERIFY_SIGNATURES` is on, an
   image-pulling backend (k8s, docker, kata) refuses with `FAILED_PRECONDITION`
   anything other than `repo[:tag]@sha256:<64 lowercase hex>`. A bare bundle
   digest is accepted only when `AGENT_IMAGE` is itself pinned. When
   `PAL_IMAGE_ALLOWED_REPOS` (comma-separated repository prefixes, matched on
   path segments) is set, the image must also come from one of those repos.
   - **Default:** on when `LANTERN_ENV`/`PAL_ENV` is prod, production or
     staging; off elsewhere.
   - An unparseable value stops the manager from starting.
   - An explicit `off` in prod is honoured, but logged at ERROR on every start.
3. **Signature and identity are verified at cluster admission, not
   in-process.** `infra/k8s/supply-chain/verify-workload-images.yaml` is a
   Kyverno `ClusterPolicy` for tenant namespaces (`lantern-t-*`, `pal-t-*`). It
   requires digest-pinned containers, init containers and ephemeral containers,
   and a cosign signature on **every** image (`imageReferences: ["*"]`) from
   the listed attestors. Both rules fail closed.
   - Offline tests for the digest rule live in `infra/k8s/supply-chain/test`
     and run in CI through `supply-chain-policy.yml`.
   - The data-plane chart's platform-image policy now trusts the real signer,
     `build-images.yml@refs/heads/master`.
4. **The docs say what is enforced:** `01-overview.md` and `AGENT.md`.

### Why not verify cosign signatures inside the runtime-manager?

- Keyless verification needs the Fulcio roots, a Rekor client, and network
  access to both on the hot path. The sigstore Rust crate pulls in a large
  dependency tree.
- The kubelet pulls by the reference the manager hands it. Only a check at
  admission sees the exact digest that runs, and it also covers pods created
  without going through the manager.
- The manager instead enforces the precondition that makes admission sound: a
  tag could be re-pointed between verification and pull, and a digest cannot.

### Why not bind to `agent_versions.digest`?

It is not a content digest of anything that gets pulled. It is `md5(name)`, and
binding to it would only look like a check. A real signed-bundle artifact
(build → push → digest recorded at version creation → verified on dispatch) is a
separate feature and needs its own ADR.

## Consequences / migration

- **Prod deployments using tag images on k8s, docker or kata will now get
  `FAILED_PRECONDITION`.** Before upgrading:
  - pin workload images (`image_digest: repo@sha256:...`, which is what
    `examples/headless-agents/*` already do);
  - pin `AGENT_IMAGE` if bare-digest requests rely on it. The built-in default
    `ghcr.io/lantern/agent-runner:latest` is a tag, and it is not an image this
    repo builds.
  - Temporary escape hatch: `PAL_VERIFY_SIGNATURES=off`, logged at ERROR.
- Before applying the Kyverno policy, add an attestor for each identity that
  signs tenant images. With only the default attestor, tenant images not signed
  by this repo's CI are refused.
- `sign-images.yml` (manual backfill) signs under its own identity. Add that
  identity as an attestor if you rely on it.

## Residual risk

- Without the Kyverno policy installed, the platform guarantees digest pinning
  but not signatures. In-process signature verification is the upgrade path if
  a cluster without an admission controller has to be supported.
- wasm modules and Firecracker rootfs are outside this gate. Firecracker rootfs
  is covered by ADR 0031; wasm has no content check yet.
- The CI verify steps run only on `master` pushes, because they need OIDC and
  registry push. On pull requests, only the offline Kyverno tests run.
