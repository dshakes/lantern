// build.rs — proto compilation hook for lantern-harness.
//
// Generates the RuntimeHarnessClient stub (client-only; the harness never
// serves RPCs — it calls the manager). Output goes to
// `$OUT_DIR/lantern.v1.rs` and is pulled in via `tonic::include_proto!`
// inside `src/proto.rs`.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../packages/proto/lantern/v1/runtime.proto";
    tonic_build::configure()
        .build_client(true)
        .build_server(false)
        .compile_protos(&[proto], &["../../packages/proto"])?;
    println!("cargo:rerun-if-changed={proto}");
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
