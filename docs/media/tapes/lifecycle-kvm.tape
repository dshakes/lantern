# REAL recording: infra/firecracker/integration-test.sh (origin/master) on the Lima VM
# `firecracker-dev` (aarch64, nested KVM, Firecracker 1.15.1 + jailer). Nothing is faked:
# the only filter is a grep for PASS/FAIL lines + the timing table the test prints.
# ~/lifecycle-e2e.sh inside the VM is just the env from infra/lima/README.md
# ("Running the lifecycle e2e test") plus FIRECRACKER_JAILER_PATH/UID/GID/CHROOT_BASE;
# harness, manager and rootfs were built beforehand from the same checkout.
# Record from the repo root: vhs docs/media/tapes/lifecycle-kvm.tape
Output docs/media/lifecycle-kvm.gif
Source docs/media/tapes/_settings.tape
Set FontSize 13
Set Width 1240
Set Height 760
Set PlaybackSpeed 2
Hide
Type "export PS1='$ ' && clear" Enter
Show
Type "# pause / resume / fork on real Firecracker — Lima nested KVM" Enter
Type "limactl shell firecracker-dev -- bash -lc '~/lifecycle-e2e.sh' 2>&1 | grep -E 'PASS|FAIL|^\|'" Enter
Wait+Screen@600s /PASS: ALL ASSERTIONS|\] FAIL:/
Sleep 8s
