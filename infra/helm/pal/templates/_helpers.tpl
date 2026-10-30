{{/*
Chart name, truncated to 63 chars (K8s label limit).
*/}}
{{/*
Chart name used in names and selector labels.
*/}}
{{- define "pal.chartName" -}}
{{- $n := default .Chart.Name .Values.nameOverride -}}
{{- $n -}}
{{- end }}

{{- define "pal.name" -}}
{{- include "pal.chartName" . | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name: <release>-<chart>.
If release name already contains the chart name, don't double it.
Truncated to 63 chars.
*/}}
{{- define "pal.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "pal.chartName" . }}
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
{{- define "pal.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: pal
{{ include "pal.selectorLabels" . }}
{{- end }}

{{/*
Selector labels (stable across upgrades).
*/}}
{{- define "pal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component-scoped labels. Call with a dict: include "pal.componentLabels" (dict "root" . "component" "gateway")
*/}}
{{- define "pal.componentLabels" -}}
{{ include "pal.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component-scoped selector labels.
*/}}
{{- define "pal.componentSelectorLabels" -}}
{{ include "pal.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "pal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "pal.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Build a full image URI for a component.
Usage: include "pal.image" (dict "root" . "component" .Values.gateway)
*/}}
{{- define "pal.image" -}}
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
{{- define "pal.dbHost" -}}
{{- if .Values.postgresql.enabled -}}
{{ include "pal.fullname" . }}-postgresql
{{- else -}}
{{ required "externalDatabase.host is required when postgresql.enabled=false" .Values.externalDatabase.host }}
{{- end -}}
{{- end }}

{{- define "pal.dbPort" -}}
{{- if .Values.postgresql.enabled }}5432{{ else }}{{ .Values.externalDatabase.port | default 5432 }}{{ end -}}
{{- end }}

{{- define "pal.dbSslmode" -}}
{{- if .Values.postgresql.enabled }}disable{{ else }}{{ .Values.externalDatabase.sslmode | default "require" }}{{ end -}}
{{- end }}

{{- define "pal.databaseURL" -}}
postgres://{{ .Values.postgresql.auth.username }}:$(POSTGRES_PASSWORD)@{{ include "pal.dbHost" . }}:{{ include "pal.dbPort" . }}/{{ .Values.postgresql.auth.database }}?sslmode={{ include "pal.dbSslmode" . }}
{{- end }}

{{/*
S3-compatible object store: the in-cluster one (minio.enabled) or externalS3.*.
*/}}
{{- define "pal.s3Endpoint" -}}
{{- if .Values.minio.enabled -}}
http://{{ include "pal.fullname" . }}-minio:9000
{{- else -}}
{{ required "externalS3.endpoint is required when minio.enabled=false" .Values.externalS3.endpoint }}
{{- end -}}
{{- end }}

{{- define "pal.s3AccessKey" -}}
{{- if .Values.minio.enabled }}{{ .Values.minio.auth.rootUser }}{{ else }}{{ required "externalS3.accessKeyId is required when minio.enabled=false" .Values.externalS3.accessKeyId }}{{ end -}}
{{- end }}
