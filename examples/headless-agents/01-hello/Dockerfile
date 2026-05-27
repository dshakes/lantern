# Demo 01: hello — minimal Python workload.
#
# Lantern base image format (defined by the harness contract):
#   * `/usr/local/bin/lantern-harness` is PID 1 (statically linked Rust binary
#     baked in by the base image — see services/harness/).
#   * The workload entrypoint is referenced by env `LANTERN_WORKLOAD_CMD`.
#   * `/run/lantern/` is a tmpfs mount the harness uses for sockets +
#     vended secrets. The workload reads secrets by name from
#     `/run/lantern/secrets/<env_name>`.
#
# For this trusted demo we use a stock python:3.12-alpine — the harness
# would be baked into the lantern/base image in real builds. For local
# iteration the harness can be skipped (`LANTERN_HARNESS=disabled`).

FROM python:3.12-alpine

WORKDIR /app
COPY workload.py /app/workload.py

# In a real Lantern image, the next line would be:
#   COPY --from=lantern/harness:latest /usr/local/bin/lantern-harness /usr/local/bin/
#   ENTRYPOINT ["/usr/local/bin/lantern-harness"]
# Until the harness is published, use python directly:
ENV LANTERN_WORKLOAD_CMD="python /app/workload.py"
ENTRYPOINT ["python", "/app/workload.py"]
