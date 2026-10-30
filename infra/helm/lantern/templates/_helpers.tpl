{{/*
Chart name, truncated to 63 chars (K8s label limit).
*/}}
{{- define "lantern.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name: <release>-<chart>.
If release name already contains the chart name, don't double it.
Truncated to 63 chars.
*/}}
{{- define "lantern.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Standard Kubernetes labels.
*/}}
{{- define "lantern.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: lantern
{{ include "lantern.selectorLabels" . }}
{{- end }}

{{/*
Selector labels (stable across upgrades).
*/}}
{{- define "lantern.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lantern.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component-scoped labels. Call with a dict: include "lantern.componentLabels" (dict "root" . "component" "gateway")
*/}}
{{- define "lantern.componentLabels" -}}
{{ include "lantern.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component-scoped selector labels.
*/}}
{{- define "lantern.componentSelectorLabels" -}}
{{ include "lantern.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "lantern.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "lantern.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Build a full image URI for a component.
Usage: include "lantern.image" (dict "root" . "component" .Values.gateway)
*/}}
{{- define "lantern.image" -}}
{{- $registry := .root.Values.global.image.registry -}}
{{- $repository := .root.Values.global.image.repository -}}
{{- $tag := default .root.Values.global.image.tag .component.image.tag -}}
{{- $name := .component.image.name -}}
{{- if $registry -}}
{{- printf "%s/%s/%s:%s" $registry $repository $name $tag -}}
{{- else -}}
{{- printf "%s/%s:%s" $repository $name $tag -}}
{{- end -}}
{{- end }}

{{/*
Database connection. In-cluster (postgresql.enabled) or externalDatabase.* (managed
Postgres). User and database names always come from postgresql.auth.*; the password
from secrets.postgresPassword (env POSTGRES_PASSWORD on every consumer).
*/}}
{{- define "lantern.dbHost" -}}
{{- if .Values.postgresql.enabled -}}
{{ include "lantern.fullname" . }}-postgresql
{{- else -}}
{{ required "externalDatabase.host is required when postgresql.enabled=false" .Values.externalDatabase.host }}
{{- end -}}
{{- end }}

{{- define "lantern.dbPort" -}}
{{- if .Values.postgresql.enabled }}5432{{ else }}{{ .Values.externalDatabase.port | default 5432 }}{{ end -}}
{{- end }}

{{- define "lantern.dbSslmode" -}}
{{- if .Values.postgresql.enabled }}disable{{ else }}{{ .Values.externalDatabase.sslmode | default "require" }}{{ end -}}
{{- end }}

{{- define "lantern.databaseURL" -}}
postgres://{{ .Values.postgresql.auth.username }}:$(POSTGRES_PASSWORD)@{{ include "lantern.dbHost" . }}:{{ include "lantern.dbPort" . }}/{{ .Values.postgresql.auth.database }}?sslmode={{ include "lantern.dbSslmode" . }}
{{- end }}

{{/*
S3-compatible object store: the in-cluster one (minio.enabled) or externalS3.*.
*/}}
{{- define "lantern.s3Endpoint" -}}
{{- if .Values.minio.enabled -}}
http://{{ include "lantern.fullname" . }}-minio:9000
{{- else -}}
{{ required "externalS3.endpoint is required when minio.enabled=false" .Values.externalS3.endpoint }}
{{- end -}}
{{- end }}

{{- define "lantern.s3AccessKey" -}}
{{- if .Values.minio.enabled }}{{ .Values.minio.auth.rootUser }}{{ else }}{{ required "externalS3.accessKeyId is required when minio.enabled=false" .Values.externalS3.accessKeyId }}{{ end -}}
{{- end }}

{{/*
Internal gRPC mTLS (ADR 0043). All emit nothing unless mtls.enabled.

lantern.mtls.env — service-mesh identity env for a component.
  include "lantern.mtls.env" (dict "root" . "name" "model-router" "peers" (list "control-plane"))
"peers" (optional) is the server-side allowlist, as service names.
*/}}
{{- define "lantern.mtls.env" -}}
{{- if .root.Values.mtls.enabled }}
- name: PAL_GRPC_TLS_CA
  value: /etc/pal/mtls/ca.crt
- name: PAL_GRPC_TLS_CERT
  value: /etc/pal/mtls/tls.crt
- name: PAL_GRPC_TLS_KEY
  value: /etc/pal/mtls/tls.key
{{- if .peers }}
{{- $td := .root.Values.mtls.trustDomain }}
{{- $ids := list }}
{{- range .peers }}{{ $ids = append $ids (printf "spiffe://%s/svc/%s" $td .) }}{{ end }}
- name: PAL_GRPC_TLS_ALLOWED_PEERS
  value: {{ join "," $ids | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/* lantern.mtls.managerClientEnv — client identity for dialing the runtime-manager. */}}
{{- define "lantern.mtls.managerClientEnv" -}}
{{- if .Values.mtls.enabled }}
- name: PAL_RUNTIME_MANAGER_TLS_CA
  value: /etc/pal/manager-mtls/ca.crt
- name: PAL_RUNTIME_MANAGER_TLS_CERT
  value: /etc/pal/manager-mtls/tls.crt
- name: PAL_RUNTIME_MANAGER_TLS_KEY
  value: /etc/pal/manager-mtls/tls.key
{{- end }}
{{- end }}

{{/* lantern.mtls.volumeMounts — (dict "root" . "manager" bool) */}}
{{- define "lantern.mtls.volumeMounts" -}}
{{- if .root.Values.mtls.enabled }}
- name: pal-mtls
  mountPath: /etc/pal/mtls
  readOnly: true
{{- if .manager }}
- name: pal-manager-mtls
  mountPath: /etc/pal/manager-mtls
  readOnly: true
{{- end }}
{{- end }}
{{- end }}

{{/* lantern.mtls.volumes — (dict "root" . "name" "control-plane" "manager" bool) */}}
{{- define "lantern.mtls.volumes" -}}
{{- if .root.Values.mtls.enabled }}
- name: pal-mtls
  secret:
    secretName: {{ include "lantern.fullname" .root }}-{{ .name }}-mtls
{{- if .manager }}
- name: pal-manager-mtls
  secret:
    secretName: {{ include "lantern.fullname" .root }}-manager-client-mtls
{{- end }}
{{- end }}
{{- end }}

{{/*
lantern.mtls.podAnnotations — Rust services (tonic) load their cert once, so a
cert-manager renewal needs a rolling restart; stakater/Reloader does that when
mtls.reloader is on. Go services hot-reload the leaf and need nothing.
*/}}
{{- define "lantern.mtls.podAnnotations" -}}
{{- if and .root.Values.mtls.enabled .root.Values.mtls.reloader }}
secret.reloader.stakater.com/reload: {{ printf "%s-%s-mtls" (include "lantern.fullname" .root) .name | quote }}
{{- end }}
{{- end }}
