| operation | n | p50 | p95 | p99 | min | max |
|---|--:|--:|--:|--:|--:|--:|
| `grpc_floor` | 20 | 18 | 25 | 26 | 17 | 26 |
| `cold_spawn_rpc` | 20 | 143 | 157 | 357 | 126 | 357 |
| `cold_boot_to_exec` | 20 | 12300 | 18101 | 19430 | 11469 | 19430 |
| `exec_roundtrip` | 100 | 115 | 190 | 235 | 26 | 236 |
| `snapshot` | 20 | 702 | 847 | 920 | 665 | 920 |
| `stop` | 20 | 198 | 210 | 211 | 191 | 211 |
| `pause` | 20 | 905 | 1057 | 1130 | 857 | 1130 |
| `restore_rpc` | 20 | 131 | 155 | 195 | 121 | 195 |
| `resume_to_exec` | 20 | 2491 | 2720 | 2737 | 2195 | 2737 |
| `fork_1_spawn_failures` | 20 | 0 | 0 | 0 | 0 | 0 |
| `fork_1_spawn_wall` | 20 | 151 | 182 | 211 | 142 | 211 |
| `fork_1_ready_wall` | 20 | 2722 | 2893 | 2940 | 2481 | 2940 |
| `fork_1_spawn_each` | 20 | 145 | 173 | 206 | 136 | 206 |
| `fork_10_spawn_failures` | 20 | 0 | 0 | 0 | 0 | 0 |
| `fork_10_spawn_wall` | 20 | 562 | 646 | 660 | 415 | 660 |
| `fork_10_spawn_each` | 200 | 473 | 579 | 631 | 222 | 637 |
| `fork_50_spawn_failures` | 20 | 0 | 1 | 1 | 0 | 1 |
| `fork_50_spawn_wall` | 20 | 7695 | 8896 | 9239 | 7065 | 9239 |
| `fork_50_spawn_each` | 990 | 1992 | 4225 | 4690 | 301 | 5144 |
| `broker_exec_baseline` | 20 | 53 | 194 | 259 | 20 | 259 |
| `broker_fetch_allowed` | 20 | 94 | 188 | 375 | 69 | 375 |
| `broker_fetch_denied` | 20 | 32 | 102 | 396 | 23 | 396 |
| `host_curl_upstream` | 20 | 49 | 59 | 193 | 42 | 193 |

fork_1_spawn_failures: 0 failed spawns across 20 batches

fork_10_spawn_failures: 0 failed spawns across 20 batches

fork_50_spawn_failures: 10 failed spawns across 20 batches
