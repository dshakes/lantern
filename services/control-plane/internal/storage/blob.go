// Package storage is the control-plane's object-storage client (S3/MinIO).
// First real S3 integration in the service — used by the secure doc-link
// feature so staged files live in shared storage (not a node-local temp dir),
// which is required now that the control-plane runs multiple replicas.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
	"go.uber.org/zap"
)

// Config is read from the already-threaded S3_* env (see cmd/server/main.go).
type Config struct {
	Endpoint  string // S3_ENDPOINT, e.g. http://localhost:9000 or minio:9000
	AccessKey string // S3_ACCESS_KEY
	Secret    string // S3_SECRET
	Region    string // S3_REGION
	Bucket    string // S3_BUCKET
}

type Blob struct {
	client *minio.Client
	bucket string
	logger *zap.Logger
}

// Object is a streamed read handle plus the metadata the caller needs to serve it.
type Object struct {
	Body        io.ReadCloser
	ContentType string
	Filename    string
	Size        int64
}

// New builds a client from config. Returns (nil, nil) when no endpoint is
// configured — a signal to callers to fall back (single-instance dev without
// MinIO); a real misconfig (bad endpoint) returns an error.
func New(cfg Config, logger *zap.Logger) (*Blob, error) {
	ep := strings.TrimSpace(cfg.Endpoint)
	if ep == "" {
		return nil, nil
	}
	secure := strings.HasPrefix(ep, "https://")
	host := strings.TrimPrefix(strings.TrimPrefix(ep, "https://"), "http://")
	region := cfg.Region
	if region == "" {
		region = "us-east-1"
	}
	client, err := minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.Secret, ""),
		Secure: secure,
		Region: region,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}
	b := &Blob{client: client, bucket: cfg.Bucket, logger: logger}
	return b, nil
}

// EnsureBucketAndLifecycle creates the bucket if absent and sets a lifecycle
// rule expiring the given prefix after expireDays — a backstop GC so staged
// objects can't accumulate even if a delete is missed (the link token's own TTL
// is the real access gate). Best-effort: a lifecycle failure is logged, not fatal.
func (b *Blob) EnsureBucketAndLifecycle(ctx context.Context, prefix string, expireDays int) error {
	if b == nil {
		return nil
	}
	exists, err := b.client.BucketExists(ctx, b.bucket)
	if err != nil {
		return fmt.Errorf("bucket exists check: %w", err)
	}
	if !exists {
		if err := b.client.MakeBucket(ctx, b.bucket, minio.MakeBucketOptions{}); err != nil {
			return fmt.Errorf("make bucket %q: %w", b.bucket, err)
		}
	}
	cfg := lifecycle.NewConfiguration()
	cfg.Rules = []lifecycle.Rule{{
		ID:         "dl-expire",
		Status:     "Enabled",
		RuleFilter: lifecycle.Filter{Prefix: prefix},
		Expiration: lifecycle.Expiration{Days: lifecycle.ExpirationDays(expireDays)},
	}}
	if err := b.client.SetBucketLifecycle(ctx, b.bucket, cfg); err != nil {
		b.logger.Warn("dl lifecycle rule not set (backstop GC disabled; token TTL still enforced)", zap.Error(err))
	}
	return nil
}

// Put streams an object into the bucket. size may be -1 (unknown) for a fully
// streamed upload; minio handles chunked upload in that case.
func (b *Blob) Put(ctx context.Context, key string, r io.Reader, size int64, contentType, filename string) error {
	if b == nil {
		return errors.New("blob store not configured")
	}
	_, err := b.client.PutObject(ctx, b.bucket, key, r, size, minio.PutObjectOptions{
		ContentType:  contentType,
		UserMetadata: map[string]string{"filename": filename},
	})
	return err
}

// Get streams an object out. Returns a not-found error when the key is absent.
func (b *Blob) Get(ctx context.Context, key string) (*Object, error) {
	if b == nil {
		return nil, errors.New("blob store not configured")
	}
	obj, err := b.client.GetObject(ctx, b.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	info, err := obj.Stat() // resolves not-found / access errors up front
	if err != nil {
		_ = obj.Close()
		return nil, err
	}
	return &Object{
		Body:        obj,
		ContentType: info.ContentType,
		Filename:    info.UserMetadata["Filename"], // minio canonicalizes X-Amz-Meta-Filename
		Size:        info.Size,
	}, nil
}

// Remove deletes an object (best-effort; missing key is not an error).
func (b *Blob) Remove(ctx context.Context, key string) error {
	if b == nil {
		return nil
	}
	return b.client.RemoveObject(ctx, b.bucket, key, minio.RemoveObjectOptions{})
}

// GCPrefix deletes every object under prefix older than olderThan. This is the
// ACTIVE cleanup that frees disk on the link's real timeline (~1h) — the bucket
// lifecycle rule only has day granularity and is just a backstop. Returns the
// number removed.
func (b *Blob) GCPrefix(ctx context.Context, prefix string, olderThan time.Duration) (int, error) {
	if b == nil {
		return 0, nil
	}
	cutoff := time.Now().Add(-olderThan)
	removed := 0
	for obj := range b.client.ListObjects(ctx, b.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if obj.Err != nil {
			return removed, obj.Err
		}
		if obj.LastModified.Before(cutoff) {
			if err := b.client.RemoveObject(ctx, b.bucket, obj.Key, minio.RemoveObjectOptions{}); err == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// IsNotFound reports whether an error from Get is a missing-key error.
func IsNotFound(err error) bool {
	return minio.ToErrorResponse(err).Code == "NoSuchKey"
}
