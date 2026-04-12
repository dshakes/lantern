package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func newInfraCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "infra",
		Short: "Manage data plane infrastructure",
		Long: `Manage the Lantern data plane deployed in your cloud infrastructure.

The data plane runs in your own EKS, GKE, or AKS cluster and connects
back to the Lantern control plane via a secure gRPC tunnel.`,
	}

	cmd.AddCommand(newInfraInstallCommand())
	cmd.AddCommand(newInfraStatusCommand())
	cmd.AddCommand(newInfraUpgradeCommand())
	cmd.AddCommand(newInfraUninstallCommand())

	return cmd
}

// --- infra install ---

func newInfraInstallCommand() *cobra.Command {
	var (
		cloud              string
		region             string
		clusterName        string
		existingCluster    string
		instanceType       string
		nodeCount          int
		outputDir          string
		firecrackerEnabled bool
	)

	cmd := &cobra.Command{
		Use:   "install",
		Short: "Generate Terraform config to install the data plane in your cloud",
		Long: `Generates Terraform configuration for deploying the Lantern data plane
into your cloud infrastructure. Review the generated files, then run
'terraform apply' to provision the resources.

Supported clouds: aws, gcp, azure`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cloud = strings.ToLower(cloud)
			if cloud != "aws" && cloud != "gcp" && cloud != "azure" {
				return fmt.Errorf("unsupported cloud %q: must be one of aws, gcp, azure", cloud)
			}

			tenantID := flags.tenantID
			if tenantID == "" {
				return fmt.Errorf("--tenant-id is required (or set LANTERN_TENANT_ID)")
			}

			if outputDir == "" {
				outputDir = fmt.Sprintf("lantern-data-plane-%s", cloud)
			}

			if isJSON() {
				return printJSON(map[string]any{
					"cloud":        cloud,
					"region":       region,
					"cluster_name": clusterName,
					"output_dir":   outputDir,
					"tenant_id":    tenantID,
				})
			}

			// Simulate the install flow.
			steps := []struct {
				msg      string
				duration time.Duration
			}{
				{fmt.Sprintf("Configuring %s data plane in %s...", cloud, region), 300 * time.Millisecond},
				{"Generating Terraform configuration...", 400 * time.Millisecond},
				{"Writing configuration files...", 200 * time.Millisecond},
			}

			for _, s := range steps {
				fmt.Fprintf(os.Stderr, "%s%s %s%s", colorDim, spinner(), s.msg, colorReset)
				time.Sleep(s.duration)
				fmt.Fprintf(os.Stderr, "\r%s%s %s%s\n", colorGreen, checkmark(), s.msg, colorReset)
			}

			// Generate the Terraform config files.
			if err := generateTerraformConfig(cloud, region, clusterName, existingCluster, instanceType, nodeCount, tenantID, outputDir, firecrackerEnabled); err != nil {
				return fmt.Errorf("generate config: %w", err)
			}

			fmt.Fprintln(os.Stderr)
			printSuccess(fmt.Sprintf("Terraform configuration written to %s/", outputDir))

			fmt.Fprintln(os.Stderr)
			printInfo("Next steps:")
			fmt.Fprintf(os.Stderr, "\n  1. Review the generated configuration:\n")
			fmt.Fprintf(os.Stderr, "     %scd %s && cat main.tf%s\n", colorCyan, outputDir, colorReset)
			fmt.Fprintf(os.Stderr, "\n  2. Set your agent token:\n")
			fmt.Fprintf(os.Stderr, "     %sexport TF_VAR_agent_token=\"<token from lantern.run/settings/data-planes>\"%s\n", colorCyan, colorReset)
			fmt.Fprintf(os.Stderr, "\n  3. Apply the Terraform:\n")
			fmt.Fprintf(os.Stderr, "     %sterraform init && terraform plan && terraform apply%s\n", colorCyan, colorReset)
			fmt.Fprintf(os.Stderr, "\n  4. Verify the connection:\n")
			fmt.Fprintf(os.Stderr, "     %slantern infra status%s\n", colorCyan, colorReset)
			fmt.Fprintln(os.Stderr)

			return nil
		},
	}

	cmd.Flags().StringVar(&cloud, "cloud", "", "Cloud provider: aws, gcp, or azure (required)")
	cmd.Flags().StringVar(&region, "region", "us-east-1", "Cloud region")
	cmd.Flags().StringVar(&clusterName, "cluster-name", "lantern-data-plane", "Name for the new Kubernetes cluster")
	cmd.Flags().StringVar(&existingCluster, "existing-cluster", "", "Name of an existing cluster to use (skips cluster creation)")
	cmd.Flags().StringVar(&instanceType, "instance-type", "", "Instance type for nodes (default: cloud-specific)")
	cmd.Flags().IntVar(&nodeCount, "node-count", 3, "Number of nodes")
	cmd.Flags().StringVar(&outputDir, "output-dir", "", "Directory for generated Terraform files (default: lantern-data-plane-<cloud>)")
	cmd.Flags().BoolVar(&firecrackerEnabled, "firecracker", false, "Enable Firecracker microVM support (requires bare-metal or nested virt)")

	_ = cmd.MarkFlagRequired("cloud")

	return cmd
}

// --- infra status ---

func newInfraStatusCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show data plane connection status",
		RunE: func(cmd *cobra.Command, args []string) error {
			if isJSON() {
				return printJSON(map[string]any{
					"status":  "spike",
					"message": "data plane status check not yet wired to backend",
				})
			}

			fmt.Fprintf(os.Stderr, "%s%s Checking data plane status...%s\n", colorDim, spinner(), colorReset)
			time.Sleep(300 * time.Millisecond)

			printWarning("This is a spike -- status check not yet wired to the backend.")
			fmt.Fprintln(os.Stderr)
			printInfo("To check manually:")
			fmt.Fprintf(os.Stderr, "  kubectl -n lantern logs -l app.kubernetes.io/component=data-plane-agent -f\n")
			fmt.Fprintf(os.Stderr, "  kubectl -n lantern port-forward svc/lantern-dp-lantern-data-plane-data-plane-agent 8090:8090\n")
			fmt.Fprintf(os.Stderr, "  curl http://localhost:8090/status\n")

			return nil
		},
	}

	return cmd
}

// --- infra upgrade ---

func newInfraUpgradeCommand() *cobra.Command {
	var version string

	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Upgrade data plane components",
		RunE: func(cmd *cobra.Command, args []string) error {
			if isJSON() {
				return printJSON(map[string]any{
					"status":  "spike",
					"message": "data plane upgrade not yet wired",
					"version": version,
				})
			}

			printWarning("This is a spike -- upgrade not yet wired to the backend.")
			fmt.Fprintln(os.Stderr)
			printInfo("To upgrade manually:")
			fmt.Fprintf(os.Stderr, "  helm upgrade lantern-dp infra/helm/lantern-data-plane \\\n")
			fmt.Fprintf(os.Stderr, "    --set global.image.tag=%s \\\n", version)
			fmt.Fprintf(os.Stderr, "    -n lantern\n")

			return nil
		},
	}

	cmd.Flags().StringVar(&version, "version", "latest", "Version to upgrade to")

	return cmd
}

// --- infra uninstall ---

func newInfraUninstallCommand() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "uninstall",
		Short: "Tear down the data plane",
		RunE: func(cmd *cobra.Command, args []string) error {
			if isJSON() {
				return printJSON(map[string]any{
					"status":  "spike",
					"message": "data plane uninstall not yet wired",
				})
			}

			if !force {
				printWarning("This will destroy all data plane resources including running agents.")
				printInfo("Re-run with --force to confirm, or tear down manually with Terraform.")
				return nil
			}

			printWarning("This is a spike -- uninstall not yet wired to the backend.")
			fmt.Fprintln(os.Stderr)
			printInfo("To uninstall manually:")
			fmt.Fprintf(os.Stderr, "  helm uninstall lantern-dp -n lantern\n")
			fmt.Fprintf(os.Stderr, "  terraform destroy\n")

			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation")

	return cmd
}

// --- helpers ---

// generateTerraformConfig writes a terraform.tfvars file for the specified cloud.
func generateTerraformConfig(cloud, region, clusterName, existingCluster, instanceType string, nodeCount int, tenantID, outputDir string, firecrackerEnabled bool) error {
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}

	// Default instance types per cloud.
	if instanceType == "" {
		switch cloud {
		case "aws":
			instanceType = "m5.xlarge"
		case "gcp":
			instanceType = "n2-standard-4"
		case "azure":
			instanceType = "Standard_D4s_v5"
		}
	}

	// Write main.tf that references the module.
	mainTF := generateMainTF(cloud, region)
	if err := os.WriteFile(filepath.Join(outputDir, "main.tf"), []byte(mainTF), 0o644); err != nil {
		return fmt.Errorf("write main.tf: %w", err)
	}

	// Write terraform.tfvars.
	tfvars := generateTFVars(cloud, region, clusterName, existingCluster, instanceType, nodeCount, tenantID, firecrackerEnabled)
	if err := os.WriteFile(filepath.Join(outputDir, "terraform.tfvars"), []byte(tfvars), 0o644); err != nil {
		return fmt.Errorf("write terraform.tfvars: %w", err)
	}

	return nil
}

func generateMainTF(cloud, region string) string {
	switch cloud {
	case "aws":
		return `# Lantern Data Plane — AWS
#
# Generated by: lantern infra install --cloud aws
# Docs: https://docs.lantern.run/deploy/aws

module "lantern_data_plane" {
  source = "github.com/dshakes/lantern//infra/terraform/aws"

  cluster_name                   = var.cluster_name
  region                         = var.region
  instance_type                  = var.instance_type
  node_count                     = var.node_count
  existing_cluster_name          = var.existing_cluster_name
  lantern_control_plane_endpoint = var.lantern_control_plane_endpoint
  tenant_id                      = var.tenant_id
  agent_token                    = var.agent_token
  firecracker_enabled            = var.firecracker_enabled
}

variable "cluster_name" {
  type    = string
  default = "lantern-data-plane"
}

variable "region" {
  type    = string
  default = "` + region + `"
}

variable "instance_type" {
  type    = string
  default = "m5.xlarge"
}

variable "node_count" {
  type    = number
  default = 3
}

variable "existing_cluster_name" {
  type    = string
  default = ""
}

variable "lantern_control_plane_endpoint" {
  type    = string
  default = "https://api.lantern.run"
}

variable "tenant_id" {
  type = string
}

variable "agent_token" {
  type      = string
  sensitive = true
}

variable "firecracker_enabled" {
  type    = bool
  default = false
}

output "cluster_endpoint" {
  value = module.lantern_data_plane.cluster_endpoint
}

output "kubeconfig_command" {
  value = module.lantern_data_plane.kubeconfig_command
}

output "data_plane_status" {
  value = module.lantern_data_plane.data_plane_status
}
`

	case "gcp":
		return `# Lantern Data Plane — GCP
#
# Generated by: lantern infra install --cloud gcp
# Docs: https://docs.lantern.run/deploy/gcp

module "lantern_data_plane" {
  source = "github.com/dshakes/lantern//infra/terraform/gcp"

  project_id                     = var.project_id
  cluster_name                   = var.cluster_name
  region                         = var.region
  machine_type                   = var.machine_type
  node_count                     = var.node_count
  existing_cluster_name          = var.existing_cluster_name
  lantern_control_plane_endpoint = var.lantern_control_plane_endpoint
  tenant_id                      = var.tenant_id
  agent_token                    = var.agent_token
  firecracker_enabled            = var.firecracker_enabled
}

variable "project_id" {
  type = string
}

variable "cluster_name" {
  type    = string
  default = "lantern-data-plane"
}

variable "region" {
  type    = string
  default = "` + region + `"
}

variable "machine_type" {
  type    = string
  default = "n2-standard-4"
}

variable "node_count" {
  type    = number
  default = 1
}

variable "existing_cluster_name" {
  type    = string
  default = ""
}

variable "lantern_control_plane_endpoint" {
  type    = string
  default = "https://api.lantern.run"
}

variable "tenant_id" {
  type = string
}

variable "agent_token" {
  type      = string
  sensitive = true
}

variable "firecracker_enabled" {
  type    = bool
  default = false
}

output "cluster_endpoint" {
  value = module.lantern_data_plane.cluster_endpoint
}

output "kubeconfig_command" {
  value = module.lantern_data_plane.kubeconfig_command
}

output "data_plane_status" {
  value = module.lantern_data_plane.data_plane_status
}
`

	case "azure":
		return `# Lantern Data Plane — Azure
#
# Generated by: lantern infra install --cloud azure
# Docs: https://docs.lantern.run/deploy/azure

module "lantern_data_plane" {
  source = "github.com/dshakes/lantern//infra/terraform/azure"

  cluster_name                   = var.cluster_name
  location                       = var.location
  vm_size                        = var.vm_size
  node_count                     = var.node_count
  existing_cluster_name          = var.existing_cluster_name
  lantern_control_plane_endpoint = var.lantern_control_plane_endpoint
  tenant_id                      = var.tenant_id
  agent_token                    = var.agent_token
  firecracker_enabled            = var.firecracker_enabled
}

variable "cluster_name" {
  type    = string
  default = "lantern-data-plane"
}

variable "location" {
  type    = string
  default = "` + region + `"
}

variable "vm_size" {
  type    = string
  default = "Standard_D4s_v5"
}

variable "node_count" {
  type    = number
  default = 3
}

variable "existing_cluster_name" {
  type    = string
  default = ""
}

variable "existing_resource_group" {
  type    = string
  default = ""
}

variable "lantern_control_plane_endpoint" {
  type    = string
  default = "https://api.lantern.run"
}

variable "tenant_id" {
  type = string
}

variable "agent_token" {
  type      = string
  sensitive = true
}

variable "firecracker_enabled" {
  type    = bool
  default = false
}

output "cluster_endpoint" {
  value = module.lantern_data_plane.cluster_endpoint
}

output "kubeconfig_command" {
  value = module.lantern_data_plane.kubeconfig_command
}

output "data_plane_status" {
  value = module.lantern_data_plane.data_plane_status
}
`

	default:
		return ""
	}
}

func generateTFVars(cloud, region, clusterName, existingCluster, instanceType string, nodeCount int, tenantID string, firecrackerEnabled bool) string {
	var b strings.Builder

	b.WriteString(fmt.Sprintf("# Generated by: lantern infra install --cloud %s\n", cloud))
	b.WriteString("# Review and modify these values as needed.\n\n")

	switch cloud {
	case "aws":
		b.WriteString(fmt.Sprintf("region        = %q\n", region))
		b.WriteString(fmt.Sprintf("cluster_name  = %q\n", clusterName))
		b.WriteString(fmt.Sprintf("instance_type = %q\n", instanceType))
		b.WriteString(fmt.Sprintf("node_count    = %d\n", nodeCount))
		if existingCluster != "" {
			b.WriteString(fmt.Sprintf("existing_cluster_name = %q\n", existingCluster))
		}
	case "gcp":
		b.WriteString(fmt.Sprintf("region       = %q\n", region))
		b.WriteString(fmt.Sprintf("cluster_name = %q\n", clusterName))
		b.WriteString(fmt.Sprintf("machine_type = %q\n", instanceType))
		b.WriteString(fmt.Sprintf("node_count   = %d\n", nodeCount))
		b.WriteString("# project_id = \"your-gcp-project-id\"\n")
		if existingCluster != "" {
			b.WriteString(fmt.Sprintf("existing_cluster_name = %q\n", existingCluster))
		}
	case "azure":
		b.WriteString(fmt.Sprintf("location     = %q\n", region))
		b.WriteString(fmt.Sprintf("cluster_name = %q\n", clusterName))
		b.WriteString(fmt.Sprintf("vm_size      = %q\n", instanceType))
		b.WriteString(fmt.Sprintf("node_count   = %d\n", nodeCount))
		if existingCluster != "" {
			b.WriteString(fmt.Sprintf("existing_cluster_name   = %q\n", existingCluster))
			b.WriteString("# existing_resource_group = \"your-resource-group\"\n")
		}
	}

	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("tenant_id = %q\n", tenantID))
	b.WriteString("# agent_token = \"<set via TF_VAR_agent_token or here>\"\n")
	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("lantern_control_plane_endpoint = %q\n", "https://api.lantern.run"))
	b.WriteString(fmt.Sprintf("firecracker_enabled = %t\n", firecrackerEnabled))

	return b.String()
}
