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
