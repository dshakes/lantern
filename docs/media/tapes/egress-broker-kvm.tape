# REAL recording: infra/firecracker/broker-e2e.sh (branch feat/egress-3-broker, PRs #300-#302)
# on the Lima VM `firecracker-dev` (aarch64, nested KVM, Firecracker 1.15.1), on the
# script's own port 51054. Nothing is faked: the only filter is a grep for PASS/FAIL lines.
# ~/broker-e2e.sh inside the VM sets FC_KERNEL_PATH/FC_ROOTFS_PATH/MANAGER_BIN to artifacts
# built beforehand from that checkout (build-image.sh with the broker-capable harness).
# The upstream is the real httpbin.org (hidden-basic-auth), so the VM needs internet.
# Record from the repo root: vhs docs/media/tapes/egress-broker-kvm.tape
Output docs/media/egress-broker-kvm.gif
Source docs/media/tapes/_settings.tape
Set FontSize 13
Set Width 1240
Set Height 420
Set PlaybackSpeed 2
Hide
Type "export PS1='$ ' && clear" Enter
Show
Type "# egress broker: no NIC in the VM, credential injected on the host — Lima nested KVM" Enter
Type "limactl shell firecracker-dev -- bash -lc '~/broker-e2e.sh' 2>&1 | grep -E 'PASS|FAIL'" Enter
Wait+Screen@600s /ASSERTIONS PASSED|\] FAIL:/
Sleep 8s
