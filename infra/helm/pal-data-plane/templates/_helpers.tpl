{{/*
Chart name, truncated to 63 chars (K8s label limit).
*/}}
{{/*
Chart name used in names and selector labels. Releases whose name contains "pal" (created before the
PAL rename, ADR 0032) keep the old chart name so their object names, selectors and PVCs do not change.
*/}}
{{- define "pal-dp.chartName" -}}
{{- $n := default .Chart.Name .Values.nameOverride -}}
{{- if contains "pal" .Release.Name -}}{{- $n = regexReplaceAll "^pal" $n "pal" -}}{{- end -}}
{{- $n -}}
{{- end }}

{{- define "pal-dp.name" -}}
{{- include "pal-dp.chartName" . | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name: <release>-<chart>.
If release name already contains the chart name, don't double it.
Truncated to 63 chars.
*/}}
{{- define "pal-dp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "pal-dp.chartName" . }}
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
{{- define "pal-dp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: pal-data-plane
{{ include "pal-dp.selectorLabels" . }}
{{- end }}

{{/*
Selector labels (stable across upgrades).
*/}}
{{- define "pal-dp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pal-dp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component-scoped labels.
*/}}
{{- define "pal-dp.componentLabels" -}}
{{ include "pal-dp.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component-scoped selector labels.
*/}}
{{- define "pal-dp.componentSelectorLabels" -}}
{{ include "pal-dp.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "pal-dp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "pal-dp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Build a full image URI for a component.
Usage: include "pal-dp.image" (dict "root" . "component" .Values.workflowEngine)
*/}}
{{- define "pal-dp.image" -}}
{{- $registry := .root.Values.global.image.registry -}}
{{- $repository := .root.Values.global.image.repository -}}
{{- $tag := default .root.Values.global.image.tag .component.image.tag -}}
{{- $name := .component.image.name -}}
{{- printf "%s/%s/%s:%s" $registry $repository $name $tag -}}
{{- end }}

{{/*
Postgres host — internal or external.
*/}}
{{- define "pal-dp.postgresHost" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgresql" (include "pal-dp.fullname" .) }}
{{- else }}
{{- .Values.postgresql.external.host }}
{{- end }}
{{- end }}

{{/*
Postgres port — internal or external.
*/}}
{{- define "pal-dp.postgresPort" -}}
{{- if .Values.postgresql.enabled }}
{{- "5432" }}
{{- else }}
{{- .Values.postgresql.external.port | toString }}
{{- end }}
{{- end }}

{{/*
Redis URL — internal or external.
*/}}
{{- define "pal-dp.redisURL" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s-redis-master:6379" (include "pal-dp.fullname" .) }}
{{- else }}
{{- printf "redis://%s:%s" .Values.redis.external.host (.Values.redis.external.port | toString) }}
{{- end }}
{{- end }}

{{/*
S3 endpoint — internal or external.
*/}}
{{- define "pal-dp.s3Endpoint" -}}
{{- if .Values.minio.enabled }}
{{- printf "http://%s-minio:9000" (include "pal-dp.fullname" .) }}
{{- else }}
{{- .Values.minio.external.endpoint }}
{{- end }}
{{- end }}

{{/*
S3 bucket — internal or external.
*/}}
{{- define "pal-dp.s3Bucket" -}}
{{- if .Values.minio.enabled }}
{{- "pal-bundles" }}
{{- else }}
{{- .Values.minio.external.bucket }}
{{- end }}
{{- end }}
