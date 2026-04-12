{{/*
Chart name, truncated to 63 chars (K8s label limit).
*/}}
{{- define "lantern-dp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name: <release>-<chart>.
If release name already contains the chart name, don't double it.
Truncated to 63 chars.
*/}}
{{- define "lantern-dp.fullname" -}}
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
{{- define "lantern-dp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: lantern-data-plane
{{ include "lantern-dp.selectorLabels" . }}
{{- end }}

{{/*
Selector labels (stable across upgrades).
*/}}
{{- define "lantern-dp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lantern-dp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component-scoped labels.
*/}}
{{- define "lantern-dp.componentLabels" -}}
{{ include "lantern-dp.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component-scoped selector labels.
*/}}
{{- define "lantern-dp.componentSelectorLabels" -}}
{{ include "lantern-dp.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "lantern-dp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "lantern-dp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Build a full image URI for a component.
Usage: include "lantern-dp.image" (dict "root" . "component" .Values.workflowEngine)
*/}}
{{- define "lantern-dp.image" -}}
{{- $registry := .root.Values.global.image.registry -}}
{{- $repository := .root.Values.global.image.repository -}}
{{- $tag := default .root.Values.global.image.tag .component.image.tag -}}
{{- $name := .component.image.name -}}
{{- printf "%s/%s/%s:%s" $registry $repository $name $tag -}}
{{- end }}

{{/*
Postgres host — internal or external.
*/}}
{{- define "lantern-dp.postgresHost" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgresql" (include "lantern-dp.fullname" .) }}
{{- else }}
{{- .Values.postgresql.external.host }}
{{- end }}
{{- end }}

{{/*
Postgres port — internal or external.
*/}}
{{- define "lantern-dp.postgresPort" -}}
{{- if .Values.postgresql.enabled }}
{{- "5432" }}
{{- else }}
{{- .Values.postgresql.external.port | toString }}
{{- end }}
{{- end }}

{{/*
Redis URL — internal or external.
*/}}
{{- define "lantern-dp.redisURL" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s-redis-master:6379" (include "lantern-dp.fullname" .) }}
{{- else }}
{{- printf "redis://%s:%s" .Values.redis.external.host (.Values.redis.external.port | toString) }}
{{- end }}
{{- end }}

{{/*
S3 endpoint — internal or external.
*/}}
{{- define "lantern-dp.s3Endpoint" -}}
{{- if .Values.minio.enabled }}
{{- printf "http://%s-minio:9000" (include "lantern-dp.fullname" .) }}
{{- else }}
{{- .Values.minio.external.endpoint }}
{{- end }}
{{- end }}

{{/*
S3 bucket — internal or external.
*/}}
{{- define "lantern-dp.s3Bucket" -}}
{{- if .Values.minio.enabled }}
{{- "lantern-bundles" }}
{{- else }}
{{- .Values.minio.external.bucket }}
{{- end }}
{{- end }}
