Kiosk specs go here (`*.spec.ts`), added by the kiosk-mode package. They run in
the same stack as `e2e/specs/` (see `../README.md`); import helpers from
`../support/*`. Add any extra control-plane env the kiosk needs in
`../global-setup.ts` (`extraEnv`).
