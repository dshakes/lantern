# Demo 01: hello — minimal Python workload.
#
# PAL base image format (defined by the harness contract):
#   * `/usr/local/bin/pal-harness` is PID 1 (statically linked Rust binary
#     baked in by the base image — see services/harness/).
#   * The workload entrypoint is referenced by env `PAL_WORKLOAD_CMD`.
#   * `/run/pal/` is a tmpfs mount the harness uses for sockets +
#     vended secrets. The workload reads secrets by name from
#     `/run/pal/secrets/<env_name>`.
#
# For this trusted demo we use a stock python:3.12-alpine — the harness
# would be baked into the pal/base image in real builds. For local
# iteration the harness can be skipped (`PAL_HARNESS=disabled`).

FROM python:3.12-alpine

WORKDIR /app
COPY workload.py /app/workload.py

# In a real PAL image, the next line would be:
#   COPY --from=pal/harness:latest /usr/local/bin/pal-harness /usr/local/bin/
#   ENTRYPOINT ["/usr/local/bin/pal-harness"]
# Until the harness is published, use python directly:
ENV PAL_WORKLOAD_CMD="python /app/workload.py"
ENTRYPOINT ["python", "/app/workload.py"]
