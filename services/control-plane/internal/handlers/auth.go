package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
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

// validateRequest extracts and validates the JWT from the Authorization header.
func (h *AuthHandler) validateRequest(r *http.Request) (*LanternClaims, error) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return nil, fmt.Errorf("missing authorization header")
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return nil, fmt.Errorf("invalid authorization header format")
	}

	return h.ValidateToken(parts[1])
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

// GetJWTSecret returns the JWT secret from the environment, with a default for development.
func GetJWTSecret() string {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		return s
	}
	return "lantern-dev-secret-change-me-in-production"
}
