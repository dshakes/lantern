// build.rs — proto compilation hook for lantern-harness.
//
// Today the harness uses hand-defined types in `src/proto.rs` that mirror
// `packages/proto/lantern/v1/runtime.proto`. That mirrors the existing
// `services/runtime-manager` convention and keeps the crate buildable
// standalone (no protoc required on the developer's box).
//
// When the project moves to a real proto codegen pipeline driven by
// `make proto`, swap the body of this file for the snippet below:
//
//     fn main() -> Result<(), Box<dyn std::error::Error>> {
//         let proto = "../../packages/proto/lantern/v1/runtime.proto";
//         tonic_build::configure()
//             .build_client(true)
//             .build_server(false)
//             .compile(&[proto], &["../../packages/proto"])?;
//         println!("cargo:rerun-if-changed={proto}");
//         Ok(())
//     }
//
// And add `tonic-build = "0.12"` to `[build-dependencies]` in Cargo.toml.
//
// TODO: regenerate from runtime.proto via `make proto` once the toolchain
//       knows how to invoke cargo build hooks.

fn main() {
    // Re-run the build script if the proto changes so future contributors
    // can flip the codegen path on without bumping anything else.
    println!("cargo:rerun-if-changed=../../packages/proto/lantern/v1/runtime.proto");
    println!("cargo:rerun-if-changed=build.rs");
}
