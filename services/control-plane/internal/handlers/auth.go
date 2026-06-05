package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// AuthHandler provides HTTP handlers for signup, login, and token introspection.
type AuthHandler struct {
	srv       *server.Server
	jwtSecret []byte
}

// NewAuthHandler creates an AuthHandler using the given server and JWT secret.
func NewAuthHandler(srv *server.Server, jwtSecret string) *AuthHandler {
	return &AuthHandler{
		srv:       srv,
		jwtSecret: []byte(jwtSecret),
	}
}

func (h *AuthHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("auth")
}

// JWTSecret returns the signing key so other handlers can validate tokens.
func (h *AuthHandler) JWTSecret() []byte {
	return h.jwtSecret
}

// ---------- request / response types ----------

type signupRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authResponse struct {
	Token string   `json:"token"`
	User  userJSON `json:"user"`
}

type userJSON struct {
	ID       string `json:"id"`
	TenantID string `json:"tenantId"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Role     string `json:"role"`
}

// ---------- JWT claims ----------

// LanternClaims extends the standard JWT claims with Lantern-specific fields.
type LanternClaims struct {
	jwt.RegisteredClaims
	TenantID string `json:"tenant_id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Role     string `json:"role"`
}

// ---------- handlers ----------

// Signup creates a new user, tenant, and returns a JWT.
func (h *AuthHandler) Signup(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req signupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Email == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email and password are required"})
		return
	}

	if len(req.Password) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be at least 6 characters"})
		return
	}

	if req.Name == "" {
		req.Name = strings.Split(req.Email, "@")[0]
	}

	ctx := r.Context()

	// Hash the password.
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		h.logger().Error("bcrypt hash failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// Check if user already exists.
	var existingID string
	err = h.srv.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE email = $1 LIMIT 1`, req.Email,
	).Scan(&existingID)
	if err == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
		return
	}
	if err != pgx.ErrNoRows {
		h.logger().Error("check existing user failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// Generate a slug for the tenant.
	slugSuffix, _ := randomHex(4)
	slug := strings.Split(req.Email, "@")[0] + "-" + slugSuffix

	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		h.logger().Error("begin tx failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Create tenant.
	var tenantID string
	err = tx.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'personal', $3)
		RETURNING id
	`, slug, req.Name+"'s Workspace", "lantern-t-"+slug).Scan(&tenantID)
	if err != nil {
		h.logger().Error("insert tenant failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// Create user.
	var userID string
	err = tx.QueryRow(ctx, `
		INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, password_hash)
		VALUES ($1, $2, $3, 'local', $4, $5)
		RETURNING id
	`, tenantID, req.Email, req.Name, req.Email, string(hash)).Scan(&userID)
	if err != nil {
		h.logger().Error("insert user failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if err := tx.Commit(ctx); err != nil {
		h.logger().Error("commit failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// Generate JWT.
	token, err := h.generateToken(userID, tenantID, req.Email, req.Name, "owner")
	if err != nil {
		h.logger().Error("token generation failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.logger().Info("user signed up",
		zap.String("user_id", userID),
		zap.String("tenant_id", tenantID),
		zap.String("email", req.Email),
	)

	writeJSON(w, http.StatusCreated, authResponse{
		Token: token,
		User: userJSON{
			ID:       userID,
			TenantID: tenantID,
			Email:    req.Email,
			Name:     req.Name,
			Role:     "owner",
		},
	})
}

// Login validates credentials and returns a JWT.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Email == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email and password are required"})
		return
	}

	ctx := r.Context()

	var (
		userID       string
		tenantID     string
		displayName  *string
		passwordHash *string
		role         string
	)
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT u.id, u.tenant_id, u.display_name, u.password_hash,
			COALESCE((SELECT 'owner' FROM tenants WHERE id = u.tenant_id LIMIT 1), 'member')
		FROM users u
		WHERE u.email = $1
		LIMIT 1
	`, req.Email).Scan(&userID, &tenantID, &displayName, &passwordHash, &role)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
			return
		}
		h.logger().Error("query user failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if passwordHash == nil || *passwordHash == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(*passwordHash), []byte(req.Password)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	// Update last_seen_at.
	_, _ = h.srv.Pool.Exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, userID)

	name := req.Email
	if displayName != nil && *displayName != "" {
		name = *displayName
	}

	token, err := h.generateToken(userID, tenantID, req.Email, name, role)
	if err != nil {
		h.logger().Error("token generation failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.logger().Info("user logged in",
		zap.String("user_id", userID),
		zap.String("email", req.Email),
	)

	writeJSON(w, http.StatusOK, authResponse{
		Token: token,
		User: userJSON{
			ID:       userID,
			TenantID: tenantID,
			Email:    req.Email,
			Name:     name,
			Role:     role,
		},
	})
}

// GetMe returns the current user from the JWT in the Authorization header.
func (h *AuthHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	claims, err := h.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or missing token"})
		return
	}

	writeJSON(w, http.StatusOK, userJSON{
		ID:       claims.Subject,
		TenantID: claims.TenantID,
		Email:    claims.Email,
		Name:     claims.Name,
		Role:     claims.Role,
	})
}

// ---------- OAuth login ----------

// oauthLoginProvider describes OAuth endpoints for login (distinct from connector OAuth).
type oauthLoginProvider struct {
	AuthURL      string
	TokenURL     string
	UserInfoURL  string
	Scopes       string
	ClientIDEnv  string
	ClientSecEnv string
}

var oauthLoginProviders = map[string]oauthLoginProvider{
	"google": {
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		UserInfoURL:  "https://www.googleapis.com/oauth2/v2/userinfo",
		Scopes:       "email profile",
		ClientIDEnv:  "GOOGLE_CLIENT_ID",
		ClientSecEnv: "GOOGLE_CLIENT_SECRET",
	},
	"github": {
		AuthURL:      "https://github.com/login/oauth/authorize",
		TokenURL:     "https://github.com/login/oauth/access_token",
		UserInfoURL:  "https://api.github.com/user",
		Scopes:       "user:email",
		ClientIDEnv:  "GITHUB_CLIENT_ID",
		ClientSecEnv: "GITHUB_CLIENT_SECRET",
	},
}

// oauthRedirectBase returns the base URL for OAuth redirect URIs.
func oauthRedirectBase() string {
	if v := os.Getenv("OAUTH_REDIRECT_BASE"); v != "" {
		return v
	}
	return "http://localhost:8080"
}

// oauthDashboardURL returns the dashboard URL for the post-login redirect.
func oauthDashboardURL() string {
	if v := os.Getenv("OAUTH_DASHBOARD_URL"); v != "" {
		return v
	}
	return "http://localhost:3001"
}

// OAuthStart initiates an OAuth login flow.
// GET /auth/oauth/{provider}/start
func (h *AuthHandler) OAuthStart(w http.ResponseWriter, r *http.Request) {
	providerName := r.PathValue("provider")

	provider, ok := oauthLoginProviders[providerName]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported OAuth provider: " + providerName})
		return
	}

	clientID := os.Getenv(provider.ClientIDEnv)
	clientSecret := os.Getenv(provider.ClientSecEnv)
	if clientID == "" || clientSecret == "" {
		displayName := strings.Title(providerName) //nolint:staticcheck
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("%s OAuth is not configured. Set %s and %s environment variables.", displayName, provider.ClientIDEnv, provider.ClientSecEnv),
		})
		return
	}

	// Generate random state token.
	stateBytes := make([]byte, 24)
	if _, err := rand.Read(stateBytes); err != nil {
		h.logger().Error("failed to generate state token", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	stateToken := hex.EncodeToString(stateBytes)

	// Store state in Redis with 10-minute TTL.
	stateData, _ := json.Marshal(map[string]string{
		"provider": providerName,
	})
	err := h.srv.Redis.Set(r.Context(), "oauth_login_state:"+stateToken, string(stateData), 10*time.Minute).Err()
	if err != nil {
		h.logger().Error("failed to store OAuth state in Redis", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	redirectURI := oauthRedirectBase() + "/auth/oauth/" + providerName + "/callback"

	params := url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirectURI},
		"response_type": {"code"},
		"state":         {stateToken},
		"scope":         {provider.Scopes},
	}

	// Google-specific params.
	if providerName == "google" {
		params.Set("access_type", "offline")
	}

	authURL := provider.AuthURL + "?" + params.Encode()
	writeJSON(w, http.StatusOK, map[string]string{"redirect_url": authURL})
}

// OAuthCallback handles the OAuth provider callback after user authorization.
// GET /auth/oauth/{provider}/callback
func (h *AuthHandler) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	providerName := r.PathValue("provider")
	dashboardURL := oauthDashboardURL()

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	oauthError := r.URL.Query().Get("error")

	if oauthError != "" {
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Authorization denied: "+oauthError), http.StatusFound)
		return
	}

	if code == "" || state == "" {
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Missing code or state parameter"), http.StatusFound)
		return
	}

	// Validate state from Redis.
	stateDataStr, err := h.srv.Redis.Get(ctx, "oauth_login_state:"+state).Result()
	if err != nil {
		h.logger().Warn("invalid or expired OAuth login state", zap.Error(err))
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Invalid or expired state token. Please try again."), http.StatusFound)
		return
	}

	// Delete state to prevent replay.
	h.srv.Redis.Del(ctx, "oauth_login_state:"+state) //nolint:errcheck

	var stateData struct {
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal([]byte(stateDataStr), &stateData); err != nil {
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Corrupted state data"), http.StatusFound)
		return
	}

	// Verify provider matches.
	if stateData.Provider != providerName {
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("State mismatch"), http.StatusFound)
		return
	}

	provider, ok := oauthLoginProviders[providerName]
	if !ok {
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Unknown provider"), http.StatusFound)
		return
	}

	// Exchange authorization code for access token.
	accessToken, err := h.exchangeOAuthLoginCode(ctx, providerName, provider, code)
	if err != nil {
		h.logger().Error("OAuth login token exchange failed", zap.Error(err), zap.String("provider", providerName))
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Token exchange failed"), http.StatusFound)
		return
	}

	// Fetch user profile from the provider.
	email, displayName, err := h.fetchOAuthUserProfile(ctx, providerName, provider, accessToken)
	if err != nil {
		h.logger().Error("OAuth user profile fetch failed", zap.Error(err), zap.String("provider", providerName))
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Failed to fetch user profile"), http.StatusFound)
		return
	}

	if email == "" {
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Could not determine email address from OAuth provider"), http.StatusFound)
		return
	}

	// Find or create user by email.
	var (
		userID   string
		tenantID string
		role     string
		name     string
	)

	err = h.srv.Pool.QueryRow(ctx, `
		SELECT u.id, u.tenant_id, u.display_name,
			COALESCE((SELECT 'owner' FROM tenants WHERE id = u.tenant_id LIMIT 1), 'member')
		FROM users u WHERE u.email = $1 LIMIT 1
	`, email).Scan(&userID, &tenantID, &name, &role)

	if err == pgx.ErrNoRows {
		// Create new user + tenant.
		if displayName == "" {
			displayName = strings.Split(email, "@")[0]
		}

		slugSuffix, _ := randomHex(4)
		slug := strings.Split(email, "@")[0] + "-" + slugSuffix

		tx, txErr := h.srv.Pool.Begin(ctx)
		if txErr != nil {
			h.logger().Error("begin tx failed", zap.Error(txErr))
			http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Internal error"), http.StatusFound)
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		txErr = tx.QueryRow(ctx, `
			INSERT INTO tenants (slug, name, tier, k8s_namespace)
			VALUES ($1, $2, 'personal', $3)
			RETURNING id
		`, slug, displayName+"'s Workspace", "lantern-t-"+slug).Scan(&tenantID)
		if txErr != nil {
			h.logger().Error("insert tenant failed", zap.Error(txErr))
			http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Internal error"), http.StatusFound)
			return
		}

		txErr = tx.QueryRow(ctx, `
			INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id
		`, tenantID, email, displayName, providerName, email).Scan(&userID)
		if txErr != nil {
			h.logger().Error("insert user failed", zap.Error(txErr))
			http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Internal error"), http.StatusFound)
			return
		}

		if txErr = tx.Commit(ctx); txErr != nil {
			h.logger().Error("commit failed", zap.Error(txErr))
			http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Internal error"), http.StatusFound)
			return
		}

		name = displayName
		role = "owner"

		h.logger().Info("new user created via OAuth",
			zap.String("user_id", userID),
			zap.String("tenant_id", tenantID),
			zap.String("email", email),
			zap.String("provider", providerName),
		)
	} else if err != nil {
		h.logger().Error("query user by email failed", zap.Error(err))
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Internal error"), http.StatusFound)
		return
	} else {
		// Existing user: update last_seen_at.
		_, _ = h.srv.Pool.Exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, userID)

		h.logger().Info("user logged in via OAuth",
			zap.String("user_id", userID),
			zap.String("email", email),
			zap.String("provider", providerName),
		)
	}

	// Issue JWT.
	token, err := h.generateToken(userID, tenantID, email, name, role)
	if err != nil {
		h.logger().Error("token generation failed", zap.Error(err))
		http.Redirect(w, r, dashboardURL+"/login?error="+url.QueryEscape("Internal error"), http.StatusFound)
		return
	}

	// Redirect to dashboard with token.
	http.Redirect(w, r, dashboardURL+"/auth/callback?token="+url.QueryEscape(token), http.StatusFound)
}

// exchangeOAuthLoginCode exchanges an authorization code for an access token.
func (h *AuthHandler) exchangeOAuthLoginCode(ctx context.Context, providerName string, provider oauthLoginProvider, code string) (string, error) {
	clientID := os.Getenv(provider.ClientIDEnv)
	clientSecret := os.Getenv(provider.ClientSecEnv)
	redirectURI := oauthRedirectBase() + "/auth/oauth/" + providerName + "/callback"

	data := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {clientID},
		"client_secret": {clientSecret},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, provider.TokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("parse token response: %w", err)
	}

	accessToken, ok := result["access_token"].(string)
	if !ok || accessToken == "" {
		return "", fmt.Errorf("no access_token in response")
	}

	return accessToken, nil
}

// fetchOAuthUserProfile fetches the user's email and display name from the provider.
func (h *AuthHandler) fetchOAuthUserProfile(ctx context.Context, providerName string, provider oauthLoginProvider, accessToken string) (email, displayName string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, provider.UserInfoURL, nil)
	if err != nil {
		return "", "", fmt.Errorf("build userinfo request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("userinfo request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", fmt.Errorf("read userinfo response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("userinfo endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var profile map[string]any
	if err := json.Unmarshal(body, &profile); err != nil {
		return "", "", fmt.Errorf("parse userinfo response: %w", err)
	}

	switch providerName {
	case "google":
		email, _ = profile["email"].(string)
		displayName, _ = profile["name"].(string)
	case "github":
		displayName, _ = profile["name"].(string)
		if displayName == "" {
			displayName, _ = profile["login"].(string)
		}
		// GitHub may not include email in profile response; fetch from /user/emails.
		email, _ = profile["email"].(string)
		if email == "" {
			email, err = h.fetchGitHubEmail(ctx, accessToken)
			if err != nil {
				return "", "", fmt.Errorf("fetch github email: %w", err)
			}
		}
	}

	return email, displayName, nil
}

// fetchGitHubEmail fetches the primary verified email from GitHub's /user/emails endpoint.
func (h *AuthHandler) fetchGitHubEmail(ctx context.Context, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user/emails", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := json.Unmarshal(body, &emails); err != nil {
		return "", err
	}

	// Prefer primary + verified.
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email, nil
		}
	}
	// Fall back to any verified.
	for _, e := range emails {
		if e.Verified {
			return e.Email, nil
		}
	}
	// Fall back to first.
	if len(emails) > 0 {
		return emails[0].Email, nil
	}

	return "", fmt.Errorf("no emails found")
}

// ---------- token helpers ----------

func (h *AuthHandler) generateToken(userID, tenantID, email, name, role string) (string, error) {
	now := time.Now()
	claims := LanternClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(30 * 24 * time.Hour)),
			Issuer:    "lantern",
		},
		TenantID: tenantID,
		Email:    email,
		Name:     name,
		Role:     role,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(h.jwtSecret)
}

// ValidateToken parses and validates a JWT string, returning the claims.
func (h *AuthHandler) ValidateToken(tokenStr string) (*LanternClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &LanternClaims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return h.jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*LanternClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	return claims, nil
}

// validateRequest extracts and validates credentials from the Authorization
// header. Accepts either a JWT or a long-lived API key (prefix hlx_live_).
func (h *AuthHandler) validateRequest(r *http.Request) (*LanternClaims, error) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return nil, fmt.Errorf("missing authorization header")
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return nil, fmt.Errorf("invalid authorization header format")
	}

	token := parts[1]
	if strings.HasPrefix(token, "hlx_live_") {
		return h.validateAPIKey(r.Context(), token)
	}
	return h.ValidateToken(token)
}

// validateAPIKey looks up an API key by its SHA-256 hash and returns synthetic
// claims with the owning tenant. API keys don't expire unless revoked or
// explicitly given an expires_at.
func (h *AuthHandler) validateAPIKey(ctx context.Context, rawKey string) (*LanternClaims, error) {
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	var tenantID, keyID string
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT id, tenant_id FROM api_keys
		WHERE key_hash = $1 AND revoked_at IS NULL
		AND (expires_at IS NULL OR expires_at > now())
	`, keyHash).Scan(&keyID, &tenantID)
	if err != nil {
		return nil, fmt.Errorf("invalid API key")
	}

	// Best-effort last-used update.
	_, _ = h.srv.Pool.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE id = $1`, keyID)

	return &LanternClaims{
		TenantID: tenantID,
		Role:     "service",
	}, nil
}

// ---------- util ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// GetJWTSecret returns the JWT secret from the environment.
//
// Behaviour by environment:
//   - Dev (LANTERN_ENV unset): returns the well-known dev fallback so
//     `make dev` works out of the box, but logs a WARN so developers
//     notice. The warn is printed to stderr (no zap at call time).
//   - Prod (LANTERN_ENV=prod/production/staging): returns "" when the
//     secret is unset or equals the dev default, signalling to main.go
//     that it must call logger.Fatal before serving any traffic.
//
// Callers in main.go should use CheckJWTSecret to enforce the prod guard.
func GetJWTSecret() string {
	s := os.Getenv("JWT_SECRET")
	if s != "" && s != devJWTSecret {
		return s
	}
	if isProd() {
		// Signal failure — main.go will Fatal on the empty return.
		return ""
	}
	// Dev default: warn once on stderr so it's visible in local logs.
	if s == "" {
		os.Stderr.WriteString("[WARN] JWT_SECRET is unset — using insecure dev default; set JWT_SECRET in production\n")
	}
	return devJWTSecret
}
