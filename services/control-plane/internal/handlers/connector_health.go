package handlers

// Connector credential health — stop retrying what can never succeed.
//
// # The failure this exists for
//
// The Gmail OAuth token was encrypted with a LANTERN_CREDENTIAL_KEY that no
// longer exists on the host. Every decrypt returned "credential is encrypted
// but LANTERN_CREDENTIAL_KEY is not set". The install still reported
// status='connected', so three cron-scheduled agents re-attempted it hourly
// and failed identically: 124 failed runs across 7 days, each one creating a
// run row and spending LLM tokens on prompt assembly before reaching a failure
// that no retry could ever clear.
//
// Nothing was wrong with the retry logic — retrying is right for a 429 or a
// dropped socket. The gap was that the runtime could not tell a TRANSIENT
// failure from a PERMANENT one, so it treated an unusable credential as though
// patience would fix it.
//
// # What this does
//
// Classifies credential failures. A permanent one quarantines the install
// (status='needs_reauth' with a human-readable reason) so that:
//
//   - the next scheduled run fails fast with an actionable message instead of
//     burning a full run,
//   - `status` stops claiming 'connected' when the credential is unusable,
//   - the owner sees what to fix and where.
//
// Recovery is deliberately a human step: re-authorizing is the only thing that
// can produce a usable token, and doing it silently is not possible. What is
// automatic is the *detection*, the *stop*, and the *explanation*.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// ConnectorStatusNeedsReauth marks an install whose stored credential cannot
// be used and will not become usable on its own.
const ConnectorStatusNeedsReauth = "needs_reauth"

// errConnectorNeedsReauth is returned instead of a bare "not installed" when
// the connector IS installed but quarantined. The distinction matters: one
// means "go install it", the other means "your credential broke, re-authorize".
type errConnectorNeedsReauth struct {
	ConnectorID string
	Reason      string
}

func (e *errConnectorNeedsReauth) Error() string {
	if e.Reason != "" {
		return fmt.Sprintf("connector %q needs re-authorization: %s", e.ConnectorID, e.Reason)
	}
	return fmt.Sprintf("connector %q needs re-authorization", e.ConnectorID)
}

// IsConnectorNeedsReauth reports whether err is a quarantine error.
func IsConnectorNeedsReauth(err error) bool {
	var target *errConnectorNeedsReauth
	return errors.As(err, &target)
}

// permanentCredentialFailure reports whether a credential error is structural
// — no amount of retrying will clear it.
//
// Deliberately conservative: anything not recognised is treated as TRANSIENT,
// because wrongly quarantining a healthy connector takes a working integration
// offline until a human notices, whereas wrongly retrying a broken one costs
// one more failed run. Errors are matched on substrings because they cross a
// package boundary as wrapped text.
func permanentCredentialFailure(err error) (reason string, permanent bool) {
	if err == nil {
		return "", false
	}
	msg := strings.ToLower(err.Error())

	switch {
	// The exact failure observed: ciphertext present, decryption key absent.
	// Only restoring the key or re-authorizing can fix this.
	case strings.Contains(msg, "lantern_credential_key is not set"):
		return "stored credential is encrypted, but the server has no LANTERN_CREDENTIAL_KEY to decrypt it. " +
			"Set LANTERN_CREDENTIAL_KEY (so new tokens are encrypted at rest), then re-authorize this connector", true

	// Key present but wrong, or the ciphertext is damaged.
	case strings.Contains(msg, "cipher: message authentication failed"),
		strings.Contains(msg, "message authentication failed"),
		strings.Contains(msg, "malformed ciphertext"):
		return "stored credential cannot be decrypted with the current LANTERN_CREDENTIAL_KEY " +
			"(wrong key, or the stored value is corrupt). Re-authorize this connector", true

	// The provider has rejected the grant itself.
	case strings.Contains(msg, "invalid_grant"),
		strings.Contains(msg, "token has been expired or revoked"),
		strings.Contains(msg, "refresh token is invalid"):
		return "the provider has revoked or expired this authorization. Re-authorize this connector", true
	}
	return "", false
}

// noteCredentialFailure classifies a credential error. A permanent one is
// replaced with an actionable typed error; transient errors pass through
// unchanged.
//
// This does NOT write to the database. The caller runs inside a WithTenant
// transaction that is rolled back precisely because the operation failed, so a
// quarantine written here would be discarded along with it — verified live: the
// error text was correct but status stayed 'connected'. Persistence is the
// caller's job via PersistConnectorQuarantine, after the transaction closes.
func noteCredentialFailure(connectorID string, err error) error {
	reason, permanent := permanentCredentialFailure(err)
	if !permanent {
		return err
	}
	return &errConnectorNeedsReauth{ConnectorID: connectorID, Reason: reason}
}

// PersistConnectorQuarantine records a permanent credential failure so the
// next attempt short-circuits instead of repeating it.
//
// Call AFTER the enclosing WithTenant transaction has returned. Best-effort and
// idempotent: quarantine is an optimisation (it stops the hourly retry storm
// and explains the breakage); the caller already has a correct, actionable
// error whether or not this write lands.
//
// Only moves a row FORWARD from its current status, so a re-authorization
// racing with a failing run is never clobbered back into quarantine.
// quarantineSQL is the single definition of the quarantine write, shared by
// the RLS-scoped and pool (rls-exempt) callers so they cannot diverge.
//
// `status <> $3` makes it idempotent: repeated failures against an
// already-quarantined install are no-ops, so failure_count counts DISTINCT
// breakages rather than incrementing once per scheduled attempt.
const quarantineSQL = `
	UPDATE connector_installs
	SET status = $3,
	    status_reason = $4,
	    status_changed_at = now(),
	    failure_count = failure_count + 1,
	    updated_at = now()
	WHERE tenant_id = $1 AND connector_id = $2 AND status <> $3`

// PersistConnectorQuarantinePool is the variant for callers holding a raw pool
// rather than a tenant transaction — the inline loop-agent executors, which
// are already rls-exempt because executeConnectorAction self-scopes by
// tenant_id. The write below is likewise explicitly scoped by tenant_id.
func PersistConnectorQuarantinePool(ctx context.Context, pool connectorExecQuerier, logger *zap.Logger, tenantID string, err error) {
	var q *errConnectorNeedsReauth
	if !errors.As(err, &q) {
		return
	}
	// rls-exempt: explicit tenant_id predicate; runs on the privileged pool
	// from the scheduled inline executor, which has no request transaction.
	if _, e := pool.Exec(ctx, quarantineSQL, tenantID, q.ConnectorID, ConnectorStatusNeedsReauth, q.Reason); e != nil && logger != nil {
		logger.Warn("could not quarantine connector",
			zap.String("connector_id", q.ConnectorID), zap.Error(e))
	} else if logger != nil {
		logger.Warn("connector quarantined: credential is permanently unusable until re-authorized",
			zap.String("connector_id", q.ConnectorID),
			zap.String("tenant_id", tenantID),
			zap.String("reason", q.Reason))
	}
}

func PersistConnectorQuarantine(ctx context.Context, srv tenantExecutor, logger *zap.Logger, tenantID string, err error) {
	var q *errConnectorNeedsReauth
	if !errors.As(err, &q) {
		return
	}
	wErr := srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, quarantineSQL,
			tenantID, q.ConnectorID, ConnectorStatusNeedsReauth, q.Reason)
		return e
	})
	if logger == nil {
		return
	}
	if wErr != nil {
		logger.Warn("could not quarantine connector after permanent credential failure",
			zap.String("connector_id", q.ConnectorID), zap.Error(wErr))
		return
	}
	logger.Warn("connector quarantined: credential is permanently unusable until re-authorized",
		zap.String("connector_id", q.ConnectorID),
		zap.String("tenant_id", tenantID),
		zap.String("reason", q.Reason))
}

// tenantExecutor is the slice of *server.Server this file needs, kept narrow
// so the health helpers stay unit-testable without a live database.
type tenantExecutor interface {
	WithTenant(ctx context.Context, fn func(pgx.Tx) error) error
}
