package internal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Credentials stores authentication data persisted on disk.
type Credentials struct {
	Token    string `json:"token"`
	Email    string `json:"email,omitempty"`
	Name     string `json:"name,omitempty"`
	TenantID string `json:"tenantId,omitempty"`
	UserID   string `json:"userId,omitempty"`
}

// ConfigDir is the CLI's config/state directory: $PAL_HOME when set, else ~/.pal.
func ConfigDir() (string, error) {
	if d := os.Getenv("PAL_HOME"); d != "" {
		return d, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home directory: %w", err)
	}
	return filepath.Join(home, ".pal"), nil
}

// CredentialsPath returns the path to credentials.json in ConfigDir.
func CredentialsPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "credentials.json"), nil
}

// LoadCredentials reads credentials from CredentialsPath.
// Returns nil (no error) if the file does not exist.
func LoadCredentials() (*Credentials, error) {
	path, err := CredentialsPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read credentials: %w", err)
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("parse credentials: %w", err)
	}
	return &creds, nil
}

// SaveCredentials writes credentials to CredentialsPath.
func SaveCredentials(creds *Credentials) error {
	path, err := CredentialsPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}
	return nil
}

// ClearCredentials removes the credentials file.
func ClearCredentials() error {
	path, err := CredentialsPath()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove credentials: %w", err)
	}
	return nil
}
