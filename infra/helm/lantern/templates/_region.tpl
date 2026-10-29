{{/*
Multi-region identity (ADR 0046, docs/runbooks/region-failover.md).
Emits nothing when region.* is unset, so single-region releases render exactly
as before. Included by every service that writes run state to Postgres.
*/}}
{{- define "lantern.regionEnv" -}}
{{- with .Values.region }}
{{- if .name }}
- name: PAL_REGION
  value: {{ .name | quote }}
{{- end }}
{{- if .fenceEpoch }}
- name: PAL_FENCE_EPOCH
  value: {{ .fenceEpoch | toString | quote }}
{{- end }}
{{- if .readOnly }}
- name: PAL_READ_ONLY
  value: "1"
{{- end }}
{{- end }}
{{- end }}
