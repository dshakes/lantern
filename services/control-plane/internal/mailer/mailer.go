// Package mailer sends transactional email (verification + password reset).
//
// One interface, three drivers selected by LANTERN_MAILER (ADR 0027):
//
//	log  (default) — writes the message to the server log. Dev prints the body
//	                 (the link); prod prints recipient + subject only, never
//	                 the body, so a token can never land in prod logs.
//	smtp           — stdlib net/smtp; LANTERN_SMTP_ADDR/_USER/_PASSWORD.
//	http           — POST {from,to,subject,text} + bearer token to
//	                 LANTERN_MAIL_HTTP_URL (Resend's /emails API shape).
package mailer

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"
)

// Message is a plain-text email.
type Message struct {
	To      string
	Subject string
	Text    string
}

// Mailer delivers a Message.
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// Driver names accepted by LANTERN_MAILER.
const (
	DriverLog  = "log"
	DriverSMTP = "smtp"
	DriverHTTP = "http"
)

// Driver returns the configured driver name (default "log").
func Driver() string {
	if d := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_MAILER"))); d != "" {
		return d
	}
	return DriverLog
}

func from() string {
	if f := os.Getenv("LANTERN_MAIL_FROM"); f != "" {
		return f
	}
	return "Lantern <no-reply@localhost>"
}

// FromEnv builds the Mailer selected by LANTERN_MAILER. prod controls whether
// the log driver may print message bodies.
func FromEnv(logger *zap.Logger, prod bool) (Mailer, error) {
	switch d := Driver(); d {
	case DriverLog:
		return &LogMailer{Logger: logger, Redact: prod}, nil
	case DriverSMTP:
		addr := os.Getenv("LANTERN_SMTP_ADDR")
		if addr == "" {
			return nil, fmt.Errorf("mailer: LANTERN_MAILER=smtp needs LANTERN_SMTP_ADDR (host:port)")
		}
		return &SMTPMailer{Addr: addr, User: os.Getenv("LANTERN_SMTP_USER"), Password: os.Getenv("LANTERN_SMTP_PASSWORD"), From: from()}, nil
	case DriverHTTP:
		url := os.Getenv("LANTERN_MAIL_HTTP_URL")
		if url == "" {
			return nil, fmt.Errorf("mailer: LANTERN_MAILER=http needs LANTERN_MAIL_HTTP_URL")
		}
		return &HTTPMailer{URL: url, Token: os.Getenv("LANTERN_MAIL_HTTP_TOKEN"), From: from(), Client: &http.Client{Timeout: 15 * time.Second}}, nil
	default:
		return nil, fmt.Errorf("mailer: unknown LANTERN_MAILER %q (want log, smtp or http)", d)
	}
}

// LogMailer writes mail to the log. Redact drops the body (prod).
type LogMailer struct {
	Logger *zap.Logger
	Redact bool
}

func (l *LogMailer) Send(_ context.Context, m Message) error {
	fields := []zap.Field{zap.String("to", m.To), zap.String("subject", m.Subject)}
	if !l.Redact {
		fields = append(fields, zap.String("body", m.Text))
	}
	l.Logger.Info("mailer(log): email not delivered — log driver", fields...)
	return nil
}

// SMTPMailer sends through an SMTP relay, upgrading with STARTTLS when the
// server offers it. PlainAuth refuses to send credentials over an unencrypted
// connection to a non-localhost server.
type SMTPMailer struct {
	Addr, User, Password, From string
}

func (s *SMTPMailer) Send(ctx context.Context, m Message) error {
	if err := checkHeaders(m); err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(s.Addr)
	if err != nil {
		return fmt.Errorf("mailer smtp: bad LANTERN_SMTP_ADDR %q: %w", s.Addr, err)
	}
	// Same steps as smtp.SendMail, but dialled with ctx and a deadline on the
	// conn so a stalled relay can never pin the sending goroutine.
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", s.Addr)
	if err != nil {
		return fmt.Errorf("mailer smtp: dial %s: %w", s.Addr, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("mailer smtp: handshake %s: %w", s.Addr, err)
	}
	defer c.Close()
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: host}); err != nil {
			return fmt.Errorf("mailer smtp: STARTTLS %s: %w", s.Addr, err)
		}
	}
	if s.User != "" {
		if err := c.Auth(smtp.PlainAuth("", s.User, s.Password, host)); err != nil {
			return fmt.Errorf("mailer smtp: auth %s: %w", s.Addr, err)
		}
	}
	if err := c.Mail(envelopeAddr(s.From)); err != nil {
		return fmt.Errorf("mailer smtp: MAIL FROM: %w", err)
	}
	if err := c.Rcpt(m.To); err != nil {
		return fmt.Errorf("mailer smtp: RCPT TO %s: %w", m.To, err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("mailer smtp: DATA: %w", err)
	}
	msg := "From: " + s.From + "\r\nTo: " + m.To + "\r\nSubject: " + m.Subject +
		"\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + m.Text
	if _, err := w.Write([]byte(msg)); err != nil {
		return fmt.Errorf("mailer smtp: write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mailer smtp: end DATA to %s: %w", m.To, err)
	}
	return c.Quit()
}

// checkHeaders refuses CR/LF in header values (header injection).
func checkHeaders(m Message) error {
	if strings.ContainsAny(m.To, "\r\n") || strings.ContainsAny(m.Subject, "\r\n") {
		return fmt.Errorf("mailer: CR/LF in To or Subject")
	}
	return nil
}

// envelopeAddr extracts the bare address from "Name <addr>".
func envelopeAddr(from string) string {
	if i, j := strings.LastIndex(from, "<"), strings.LastIndex(from, ">"); i >= 0 && j > i {
		return from[i+1 : j]
	}
	return from
}

// HTTPMailer POSTs JSON to an email API (Resend-compatible).
type HTTPMailer struct {
	URL, Token, From string
	Client           *http.Client
}

func (h *HTTPMailer) Send(ctx context.Context, m Message) error {
	if err := checkHeaders(m); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"from": h.From, "to": []string{m.To}, "subject": m.Subject, "text": m.Text})
	if err != nil {
		return fmt.Errorf("mailer http: encode: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("mailer http: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if h.Token != "" {
		req.Header.Set("Authorization", "Bearer "+h.Token)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return fmt.Errorf("mailer http: POST %s: %w", h.URL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("mailer http: POST %s: status %d: %s", h.URL, resp.StatusCode, snippet)
	}
	return nil
}
