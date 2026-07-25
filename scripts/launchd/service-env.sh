#!/usr/bin/env bash
# Shared local-dev defaults for the runtime services.
#
# WHY THIS FILE EXISTS
# --------------------
# The same wiring values lived in two places: the `make run-*` targets and the
# dev.lantern.*.plist LaunchAgents. They agreed only by luck. When they drift,
# the failure is silent and expensive — the runtime-manager plist was missing
# SCHEDULER_URL entirely, so under launchd the node never self-registered, the
# scheduler marked it draining, and every placement failed FailedPrecondition
# while the manager process itself looked perfectly healthy. It "worked" only
# when someone happened to start it via `make run-runtime-manager`, which did
# set the variable.
#
# Both paths now source this file, so a port or address is changed in exactly
# one place.
#
# SEMANTICS
# ---------
# Every assignment uses `: "${VAR:=default}"`, which only fills a value that is
# unset or empty. Precedence, strongest first:
#
#   1. Whatever is already exported (a plist's EnvironmentVariables, or an
#      operator running `SCHEDULER_URL=... make run-runtime-manager`)
#   2. These defaults
#
# So a plist can still override for a real multi-node deployment; this only
# guarantees a sane single-host default is never simply absent.
#
# Usage:  . scripts/launchd/service-env.sh

# --- runtime-scheduler ---------------------------------------------------
# gRPC placement API, and the REST gateway the manager heartbeats into.
: "${LANTERN_SCHEDULER_GRPC_ADDR:=localhost:50055}"
: "${SCHEDULER_HTTP_ADDR:=:8085}"

# --- runtime-manager -----------------------------------------------------
# The node dials the scheduler's REST gateway to self-register. Unset means no
# heartbeat at all, which is the outage described above.
: "${SCHEDULER_URL:=http://localhost:8085}"
# Stable node identity. Unset falls back to the machine hostname, which changes
# on some networks and silently registers a second node.
: "${NODE_NAME:=local-dev}"
: "${NODE_ADVERTISE_ADDR:=localhost:50054}"
: "${NODE_REGION:=local}"
: "${NODE_ZONE:=local-a}"

# The address the scheduler dials to reach this node's manager.
: "${LANTERN_DEFAULT_MANAGER_ADDR:=localhost:50054}"

# --- shared --------------------------------------------------------------
# LOCAL DEV ONLY. This is the same well-known value the control-plane already
# falls back to, so setting it here changes nothing — it just means the
# scheduler and API agree without the Makefile restating it. It is NOT a way
# to run in production: handlers.GetJWTSecret() treats this exact string as
# unset when LANTERN_ENV is prod, and runStartupGuards then refuses to boot.
: "${JWT_SECRET:=lantern-dev-jwt-secret-do-not-use-in-production}"

export LANTERN_SCHEDULER_GRPC_ADDR SCHEDULER_HTTP_ADDR \
       SCHEDULER_URL NODE_NAME NODE_ADVERTISE_ADDR NODE_REGION NODE_ZONE \
       LANTERN_DEFAULT_MANAGER_ADDR JWT_SECRET
