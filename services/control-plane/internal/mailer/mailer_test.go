package mailer

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestFromEnv(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		wantErr string
		want    string
	}{
		{name: "default log", want: "*mailer.LogMailer"},
		{name: "smtp needs addr", env: map[string]string{"PAL_MAILER": "smtp"}, wantErr: "LANTERN_SMTP_ADDR"},
		{name: "smtp ok", env: map[string]string{"PAL_MAILER": "smtp", "PAL_SMTP_ADDR": "mx:587"}, want: "*mailer.SMTPMailer"},
		{name: "http needs url", env: map[string]string{"PAL_MAILER": "http"}, wantErr: "LANTERN_MAIL_HTTP_URL"},
		{name: "http ok", env: map[string]string{"PAL_MAILER": "HTTP", "PAL_MAIL_HTTP_URL": "https://x"}, want: "*mailer.HTTPMailer"},
		{name: "unknown", env: map[string]string{"PAL_MAILER": "carrier-pigeon"}, wantErr: "unknown LANTERN_MAILER"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, k := range []string{"PAL_MAILER", "PAL_SMTP_ADDR", "PAL_MAIL_HTTP_URL"} {
				t.Setenv(k, tc.env[k])
			}
			m, err := FromEnv(zap.NewNop(), false)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := typeName(m); got != tc.want {
				t.Fatalf("driver = %s, want %s", got, tc.want)
			}
		})
	}
}

func typeName(m Mailer) string {
	switch m.(type) {
	case *LogMailer:
		return "*mailer.LogMailer"
	case *SMTPMailer:
		return "*mailer.SMTPMailer"
	case *HTTPMailer:
		return "*mailer.HTTPMailer"
	}
	return "?"
}

// The log driver must never print the body (which carries the token) in prod.
func TestLogMailer_RedactsBodyInProd(t *testing.T) {
	for _, redact := range []bool{false, true} {
		core, logs := observer.New(zap.InfoLevel)
		m := &LogMailer{Logger: zap.New(core), Redact: redact}
		if err := m.Send(context.Background(), Message{To: "a@b.test", Subject: "s", Text: "link?token=SECRET"}); err != nil {
			t.Fatal(err)
		}
		_, hasBody := logs.All()[0].ContextMap()["body"]
		if hasBody == redact {
			t.Fatalf("redact=%v: body logged=%v", redact, hasBody)
		}
	}
}

func TestHTTPMailer(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		if got["subject"] == "fail" {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	m := &HTTPMailer{URL: srv.URL, Token: "tok", From: "f@x.test", Client: srv.Client()}

	if err := m.Send(context.Background(), Message{To: "a@b.test", Subject: "hi", Text: "body"}); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer tok" || got["text"] != "body" || got["from"] != "f@x.test" {
		t.Fatalf("auth=%q payload=%v", auth, got)
	}
	if err := m.Send(context.Background(), Message{To: "a@b.test", Subject: "fail"}); err == nil || !strings.Contains(err.Error(), "422") {
		t.Fatalf("want 422 error, got %v", err)
	}
	if err := m.Send(context.Background(), Message{To: "a@b.test\r\nBcc: x@y", Subject: "s"}); err == nil {
		t.Fatal("header injection not refused")
	}
}

// fakeSMTP is a minimal plaintext SMTP server that records the DATA payload.
func fakeSMTP(t *testing.T) (addr string, data chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	data = make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		say := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
		say("220 fake")
		var body strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					inData = false
					data <- body.String()
					say("250 ok")
					continue
				}
				body.WriteString(line)
				continue
			}
			switch cmd := strings.ToUpper(strings.TrimSpace(line)); {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				say("250 fake")
			case cmd == "DATA":
				inData = true
				say("354 go")
			case cmd == "QUIT":
				say("221 bye")
				return
			default:
				say("250 ok")
			}
		}
	}()
	return ln.Addr().String(), data
}

func TestSMTPMailer(t *testing.T) {
	addr, data := fakeSMTP(t)
	m := &SMTPMailer{Addr: addr, From: "Lantern <no-reply@x.test>"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Send(ctx, Message{To: "a@b.test", Subject: "Verify", Text: "click here"}); err != nil {
		t.Fatal(err)
	}
	got := <-data
	if !strings.Contains(got, "Subject: Verify") || !strings.Contains(got, "click here") {
		t.Fatalf("DATA = %q", got)
	}
}

func TestSMTPMailer_DialFailureWrapped(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close() // nothing listening
	err := (&SMTPMailer{Addr: addr, From: "x@y"}).Send(context.Background(), Message{To: "a@b.test"})
	if err == nil || !strings.Contains(err.Error(), "dial") {
		t.Fatalf("want dial error, got %v", err)
	}
}
