{{/*
Chart name, truncated to 63 chars (K8s label limit).
*/}}
{{/*
Chart name used in names and selector labels. Releases whose name contains "pal" (created before the
PAL rename, ADR 0032) keep the old chart name so their object names, selectors and PVCs do not change.
*/}}
{{- define "pal-cp.chartName" -}}
{{- $n := default .Chart.Name .Values.nameOverride -}}
{{- if contains "pal" .Release.Name -}}{{- $n = regexReplaceAll "^pal" $n "pal" -}}{{- end -}}
{{- $n -}}
{{- end }}

{{- define "pal-cp.name" -}}
{{- include "pal-cp.chartName" . | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name: <release>-<chart>.
If release name already contains the chart name, don't double it.
Truncated to 63 chars.
*/}}
{{- define "pal-cp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "pal-cp.chartName" . }}
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
{{- define "pal-cp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: pal-control-plane
{{ include "pal-cp.selectorLabels" . }}
{{- end }}

{{/*
Selector labels (stable across upgrades).
*/}}
{{- define "pal-cp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pal-cp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component-scoped labels.
*/}}
{{- define "pal-cp.componentLabels" -}}
{{ include "pal-cp.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component-scoped selector labels.
*/}}
{{- define "pal-cp.componentSelectorLabels" -}}
{{ include "pal-cp.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "pal-cp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "pal-cp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Build a full image URI for a component.
Usage: include "pal-cp.image" (dict "root" . "component" .Values.gateway)
*/}}
{{- define "pal-cp.image" -}}
{{- $registry := .root.Values.global.image.registry -}}
{{- $repository := .root.Values.global.image.repository -}}
{{- $tag := default .root.Values.global.image.tag .component.image.tag -}}
{{- $name := .component.image.name -}}
{{- printf "%s/%s/%s:%s" $registry $repository $name $tag -}}
{{- end }}
