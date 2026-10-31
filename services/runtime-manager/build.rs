// build.rs — tonic-build codegen for the runtime-manager.
//
// Generates Rust types + server/client stubs for `pal.v1` from
// `packages/proto/pal/v1/runtime.proto`. Output goes to
// `$OUT_DIR/pal.v1.rs` and is pulled in via `tonic::include_proto!`
// inside `src/proto.rs`.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../packages/proto/pal/v1/runtime.proto";

    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&[proto], &["../../packages/proto"])?;

    println!("cargo:rerun-if-changed={proto}");
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
