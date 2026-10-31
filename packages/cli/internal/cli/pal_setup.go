package cli

// pal_setup.go — `pal setup`: the terminal twin of the dashboard's
// /pal/onboarding (ADR 0048). Same steps, same server: the control plane owns
// the state machine and returns `resumeStep`; this command never re-derives
// it, so the dashboard, the CLI and the server cannot drift.
//
//   welcome → channels → voice → trust → profile → done (first Brief)
//
// Every step advances only on a real result: a live bridge check, a 2xx save,
// a read-back that matches. Consent is never given non-interactively.
//
// `pal setup --apply` writes what was set up into this Mac's bridge config:
// the confirmed facts/relationships into the owner profile, and quiet hours +
// the voice setting into bridge.env (both backed up first).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dshakes/pal/packages/cli/internal"
	"github.com/spf13/cobra"
)

// palConsentVersion must equal PalConsentVersion in the control plane
// (pinned by services/testdata/pal_onboarding_cases.json).
const palConsentVersion = "2026-10"

var palLifeEventKinds = []string{"bill", "delivery", "appointment", "fraud_alert", "otp", "travel", "receipt", "promo"}

// ---- the server document (subset the CLI reads/writes) ----------------------

type palDoc struct {
	Step        string          `json:"step"`
	Consent     *palDocConsent  `json:"consent,omitempty"`
	Channels    *palDocChannels `json:"channels,omitempty"`
	Voice       json.RawMessage `json:"voice,omitempty"`
	Trust       *palDocTrust    `json:"trust,omitempty"`
	Profile     *palDocProfile  `json:"profile,omitempty"`
	CompletedAt *string         `json:"completedAt,omitempty"`
	ResumeStep  string          `json:"resumeStep,omitempty"`
}

type palDocConsent struct {
	Version       string `json:"version"`
	AcceptedAt    string `json:"acceptedAt,omitempty"`
	VoiceSampling bool   `json:"voiceSampling,omitempty"`
}

type palDocChannels struct {
	WhatsApp string `json:"whatsapp,omitempty"`
	IMessage string `json:"imessage,omitempty"`
}

type palDocTrust struct {
	PrefsSaved        bool `json:"prefsSaved,omitempty"`
	HoldsAcknowledged bool `json:"holdsAcknowledged,omitempty"`
	QuietStart        *int `json:"quietStart,omitempty"`
	QuietEnd          *int `json:"quietEnd,omitempty"`
}

type palDocProfileItem struct {
	Section   string   `json:"section"`
	Key       string   `json:"key"`
	Value     string   `json:"value"`
	AddressAs string   `json:"addressAs,omitempty"`
	Never     []string `json:"never,omitempty"`
	Quote     string   `json:"quote,omitempty"`
}

type palDocProfile struct {
	Items []palDocProfileItem `json:"items,omitempty"`
	Done  bool                `json:"done,omitempty"`
}

type palVoiceDoc struct {
	Profile     map[string]any `json:"profile,omitempty"`
	Preview     map[string]any `json:"preview,omitempty"`
	SampleCount int            `json:"sampleCount,omitempty"`
	Approved    bool           `json:"approved,omitempty"`
	Skipped     bool           `json:"skipped,omitempty"`
}

func (d *palDoc) voice() palVoiceDoc {
	var v palVoiceDoc
	if len(d.Voice) > 0 {
		_ = json.Unmarshal(d.Voice, &v)
	}
	return v
}

func (d *palDoc) setVoice(v palVoiceDoc) {
	d.Voice, _ = json.Marshal(v)
}

func (d *palDoc) mayLearnVoice() bool {
	return d.Consent != nil && d.Consent.AcceptedAt != "" && d.Consent.Version == palConsentVersion && d.Consent.VoiceSampling
}

// ---- channel readiness (mirrors pal-onboarding-logic.ts; fixture-pinned) -----

type bridgeProbe struct {
	Reachable  bool
	HTTPStatus int
	Status     string // WhatsApp /status .status
	Paired     bool
	State      string // iMessage /diagnostics .state
	Reason     string
}

func palWhatsAppReadiness(p bridgeProbe) string {
	if !p.Reachable || p.HTTPStatus == 503 || p.HTTPStatus == 502 {
		return "offline"
	}
	if p.HTTPStatus == 401 || p.HTTPStatus == 403 {
		return "unauthorized"
	}
	if p.Paired && p.Status == "connected" {
		return "connected"
	}
	if p.Paired {
		return "connecting"
	}
	return "needs_pairing"
}

var (
	reFDA        = regexp.MustCompile(`(?i)full disk access|permission denied reading chat\.db`)
	reAutomation = regexp.MustCompile(`(?i)automation`)
	reNotSetUp   = regexp.MustCompile(`(?i)chat\.db not found`)
	reMessagesNA = regexp.MustCompile(`(?i)not available or not logged|not running`)
)

func palIMessageReadiness(p bridgeProbe) string {
	if !p.Reachable || p.HTTPStatus == 503 || p.HTTPStatus == 502 {
		return "offline"
	}
	if p.HTTPStatus == 401 || p.HTTPStatus == 403 {
		return "unauthorized"
	}
	if p.HTTPStatus == 501 {
		return "unsupported"
	}
	if p.HTTPStatus != 0 && (p.HTTPStatus < 200 || p.HTTPStatus >= 300) {
		return "error"
	}
	state := p.State
	if state == "" {
		state = "idle"
	}
	switch {
	case state == "ready":
		return "ready"
	case state == "idle":
		return "not_started"
	case state == "starting":
		return "starting"
	case state == "messages_not_running" || reMessagesNA.MatchString(p.Reason):
		return "messages_unavailable"
	case state == "permission_required":
		switch {
		case reFDA.MatchString(p.Reason):
			return "needs_full_disk_access"
		case reAutomation.MatchString(p.Reason):
			return "needs_automation"
		case reNotSetUp.MatchString(p.Reason):
			return "not_set_up"
		}
		return "needs_permission"
	}
	return "error"
}

var palChannelFixes = map[string]string{
	"offline":                "the bridge isn't running — start it (`pal dev`), then re-check",
	"unauthorized":           "the bridge token doesn't match — set the same PAL_BRIDGE_TOKEN / PAL_IMESSAGE_BRIDGE_TOKEN here and on the bridge",
	"unsupported":            "iMessage needs a Mac",
	"not_started":            "session not started — I can start it and check permissions",
	"starting":               "starting…",
	"needs_full_disk_access": "System Settings → Privacy & Security → Full Disk Access → enable the app running the bridge, then restart it",
	"needs_automation":       "System Settings → Privacy & Security → Automation → enable Messages for the app running the bridge",
	"not_set_up":             "open Messages and sign in to iMessage",
	"messages_unavailable":   "open Messages and make sure it's signed in",
	"needs_permission":       "grant Full Disk Access and Automation → Messages to the app running the bridge",
	"error":                  "the bridge returned an error — check its log",
	"needs_pairing":          "not linked — scan the QR in WhatsApp → Settings → Linked devices",
	"connecting":             "linked, reconnecting — keep your phone online",
}

// ---- config ---------------------------------------------------------------------

type palSetupConfig struct {
	restURL     string
	reader      onboardReader
	yes         bool
	apply       bool
	forceTTY    bool
	waURL       string
	waToken     string
	imURL       string
	imToken     string
	dashURL     string
	stateDir    string // override (tests)
	profilePath string // override (tests)
	out         io.Writer
	http        *http.Client
	pollEvery   time.Duration
}

func (c *palSetupConfig) interactive() bool {
	return !c.yes && (c.forceTTY || (&onboardConfig{}).isTTY())
}

func (c *palSetupConfig) line() string {
	r := c.reader
	if r == nil {
		r = termReader{}
	}
	s, _ := r.ReadLine()
	return strings.TrimSpace(s)
}

func (c *palSetupConfig) printf(format string, a ...any) { fmt.Fprintf(c.out, format, a...) }

func (c *palSetupConfig) ask(prompt string) string {
	c.printf("%s ", prompt)
	return c.line()
}

func (c *palSetupConfig) yesNo(prompt string, def bool) bool {
	hint := "[y/N]"
	if def {
		hint = "[Y/n]"
	}
	a := strings.ToLower(c.ask(prompt + " " + hint))
	if a == "" {
		return def
	}
	return a == "y" || a == "yes"
}

func envFirst(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

func newPalSetupCommand() *cobra.Command {
	var yes, apply bool
	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Set up pal: connect channels, learn your voice, set trust, capture your people",
		Long: `Agentic first-run for pal, the terminal twin of the dashboard's /pal/onboarding.
Resumes where you left off (state is kept server-side). Each step advances only
on a real result: a live bridge check, a saved setting read back, your explicit
confirmation. Consent is never given non-interactively.

--apply writes what you set up into this Mac's bridge config: your confirmed
facts and people into the owner profile, and quiet hours + voice learning into
bridge.env. Both files are backed up first.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg := &palSetupConfig{
				restURL: deriveRESTURL(flags.apiURL),
				yes:     yes,
				apply:   apply,
				waURL:   envFirst("PAL_BRIDGE_URL", "NEXT_PUBLIC_PAL_BRIDGE_URL"),
				waToken: envFirst("PAL_BRIDGE_TOKEN"),
				imURL:   envFirst("PAL_IMESSAGE_BRIDGE_URL", "NEXT_PUBLIC_PAL_IMESSAGE_BRIDGE_URL"),
				imToken: envFirst("PAL_IMESSAGE_BRIDGE_TOKEN"),
				dashURL: envFirst("PAL_DASHBOARD_URL"),
			}
			return runPalSetup(cfg)
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "Never prompt: report where setup stands (and apply with --apply) without changing consent")
	cmd.Flags().BoolVar(&apply, "apply", false, "Write the setup (profile, quiet hours, voice) into this Mac's bridge config")
	return cmd
}

func (c *palSetupConfig) defaults() {
	if c.out == nil {
		c.out = os.Stderr
	}
	if c.http == nil {
		c.http = &http.Client{Timeout: 20 * time.Second}
	}
	if c.waURL == "" {
		c.waURL = "http://localhost:3100"
	}
	if c.imURL == "" {
		c.imURL = "http://localhost:3200"
	}
	if c.dashURL == "" {
		c.dashURL = "http://localhost:3001"
	}
	if c.pollEvery == 0 {
		c.pollEvery = 2 * time.Second
	}
	if c.restURL == "" {
		c.restURL = deriveRESTURL(flags.apiURL)
	}
}

// ---- bridges (read-only use of existing endpoints) -------------------------------

func (c *palSetupConfig) bridge(channel, method, path string, body any, out any) (int, error) {
	base, token := c.waURL, c.waToken
	if channel == "imessage" {
		base, token = c.imURL, c.imToken
	}
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, strings.TrimRight(base, "/")+path, rdr)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if out != nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, out)
	}
	return resp.StatusCode, nil
}

type palChannelReport struct{ WhatsApp, IMessage string }

func (r palChannelReport) verified() bool { return r.WhatsApp == "connected" || r.IMessage == "ready" }

func (r palChannelReport) live() []string {
	var out []string
	if r.IMessage == "ready" {
		out = append(out, "imessage")
	}
	if r.WhatsApp == "connected" {
		out = append(out, "whatsapp")
	}
	return out
}

func (c *palSetupConfig) checkChannels(tenant string) palChannelReport {
	t := "/session/" + tenant
	var wa struct {
		Status string `json:"status"`
		Paired bool   `json:"paired"`
	}
	code, err := c.bridge("whatsapp", http.MethodGet, t+"/status", nil, &wa)
	waP := bridgeProbe{Reachable: err == nil, HTTPStatus: code, Status: wa.Status, Paired: wa.Paired}
	var im struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	}
	code, err = c.bridge("imessage", http.MethodGet, t+"/diagnostics", nil, &im)
	imP := bridgeProbe{Reachable: err == nil, HTTPStatus: code, State: im.State, Reason: im.Reason}
	return palChannelReport{WhatsApp: palWhatsAppReadiness(waP), IMessage: palIMessageReadiness(imP)}
}

func (c *palSetupConfig) printChannels(r palChannelReport) {
	mark := func(ok bool) string {
		if ok {
			return colorGreen + "✓" + colorReset
		}
		return colorYellow + "•" + colorReset
	}
	c.printf("   %s iMessage: %s\n", mark(r.IMessage == "ready"), palChannelLine(r.IMessage, "ready"))
	c.printf("   %s WhatsApp: %s\n", mark(r.WhatsApp == "connected"), palChannelLine(r.WhatsApp, "connected"))
}

func palChannelLine(state, ok string) string {
	if state == ok {
		return "connected"
	}
	return palChannelFixes[state]
}

// ---- main flow --------------------------------------------------------------------

var errPalConsentNeedsTTY = errors.New("setup: consent can only be given interactively — run `pal setup` in a terminal")

func runPalSetup(cfg *palSetupConfig) error {
	cfg.defaults()
	cfg.printf("pal setup\n%s\n", strings.Repeat("─", 48))

	if err := onboardHealth(cfg.restURL); err != nil {
		return fmt.Errorf("setup: the pal API isn't reachable (%v) — start it with `pal dev`", err)
	}
	token, _, err := onboardAuth(cfg.restURL)
	if err != nil {
		return fmt.Errorf("setup: sign in first (`pal login`): %w", err)
	}
	client := internal.NewRESTClient(cfg.restURL, "", token)
	me, err := client.GetMe()
	if err != nil || me.TenantID == "" {
		return fmt.Errorf("setup: couldn't read your account: %v", err)
	}
	tenant := me.TenantID
	owner := strings.Fields(me.Name + " ")
	ownerFirst := ""
	if len(owner) > 0 {
		ownerFirst = owner[0]
	}

	var doc palDoc
	if err := client.Call(http.MethodGet, "/v1/pal/onboarding", nil, &doc); err != nil {
		return fmt.Errorf("setup: read progress: %w", err)
	}
	if cfg.apply {
		return palApply(cfg, client, &doc)
	}

	var report palChannelReport
	for steps := 0; steps < 12; steps++ {
		switch doc.ResumeStep {
		case "welcome":
			err = palStepWelcome(cfg, client, &doc)
		case "channels", "voice":
			// The server resumes at "channels" until voice is done: channels
			// are never persisted as passed, so they are re-verified live and
			// a pass leads straight into voice (palCanEnter(voice, …, true)).
			if report, err = palStepChannels(cfg, client, &doc, tenant); err == nil {
				err = palStepVoice(cfg, client, &doc, tenant, ownerFirst, report)
			}
		case "trust":
			err = palStepTrust(cfg, client, &doc)
		case "profile":
			err = palStepProfile(cfg, client, &doc)
		case "done":
			return palStepDone(cfg, client, &doc, tenant)
		default:
			return fmt.Errorf("setup: server returned unknown step %q", doc.ResumeStep)
		}
		if err != nil {
			return err
		}
	}
	return errors.New("setup: did not converge")
}

// save PUTs the document and adopts the server's view (incl. resumeStep).
func palSave(client *internal.RESTClient, doc *palDoc) error {
	body := *doc
	body.ResumeStep = ""
	var saved palDoc
	if err := client.Call(http.MethodPut, "/v1/pal/onboarding", body, &saved); err != nil {
		return fmt.Errorf("setup: save progress: %w", err)
	}
	*doc = saved
	return nil
}

// palGuide asks the onboarding agent; deterministic fallback on any error.
func palGuide(client *internal.RESTClient, step, message, context, fallback string) string {
	var out struct {
		Reply string `json:"reply"`
	}
	if err := client.Call(http.MethodPost, "/v1/pal/onboarding/guide", map[string]string{"step": step, "message": message, "context": context}, &out); err != nil || strings.TrimSpace(out.Reply) == "" {
		return fallback
	}
	return strings.TrimSpace(out.Reply)
}

const palWelcomeFallback = "I'm pal. I answer your iMessage and WhatsApp in your own voice and keep a short Brief of what needs you. I run on your Mac and use your own model key. Anything that promises money or claims something I can't check is held for you, always."

const palHoldsText = "Holds are always on: pal never sends a reply that promises money or commits you to something, a claim it can't verify (a date, an outcome), or a light reply to bad news. Those come to you as drafts, whatever you set here."

func palStepWelcome(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc) error {
	cfg.printf("\n1. Meet pal\n   %s\n\n", palGuide(client, "welcome", "Introduce yourself to a new owner and explain what you'll touch before asking for consent.", "", palWelcomeFallback))
	if !cfg.interactive() {
		return errPalConsentNeedsTTY
	}
	for {
		q := cfg.ask("   Any questions first? (Enter to continue) >")
		if q == "" {
			break
		}
		cfg.printf("   %s\n", palGuide(client, "welcome", q, "", "I couldn't answer that right now; the consent below says exactly what I'll do."))
	}
	if !cfg.yesNo("   pal may read your iMessage/WhatsApp on this Mac and reply as you, sending conversation text to your own model provider. Agree?", false) {
		cfg.printf("   Nothing was changed. Run `pal setup` when you're ready.\n")
		return errors.New("setup: consent declined")
	}
	voice := cfg.yesNo("   Optional: learn your voice from messages you've sent (read once, not stored)?", false)
	doc.Step = "channels"
	doc.Consent = &palDocConsent{Version: palConsentVersion, AcceptedAt: time.Now().UTC().Format(time.RFC3339), VoiceSampling: voice}
	return palSave(client, doc)
}

func palStepChannels(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc, tenant string) (palChannelReport, error) {
	cfg.printf("\n2. Connect channels (checked live)\n")
	r := cfg.checkChannels(tenant)
	cfg.printChannels(r)
	for !r.verified() {
		if !cfg.interactive() {
			return r, errors.New("setup: no channel is connected yet — fix one of the above and run `pal setup` again")
		}
		cfg.printf("   %s\n", palGuide(client, "channels", "Neither channel is ready yet. What exactly should I fix first?",
			fmt.Sprintf("Live checks: WhatsApp=%s; iMessage=%s", r.WhatsApp, r.IMessage), "Fix one channel above, then re-check."))
		choice := strings.ToLower(cfg.ask("   [i] start iMessage + check permissions  [w] link WhatsApp  [Enter] re-check  [q] quit >"))
		switch choice {
		case "q":
			return r, errors.New("setup: stopped at channels — run `pal setup` to resume")
		case "i":
			_, _ = cfg.bridge("imessage", http.MethodPost, "/session/"+tenant+"/start", nil, nil)
		case "w":
			if _, err := cfg.bridge("whatsapp", http.MethodPost, "/session/"+tenant+"/start", nil, nil); err == nil {
				cfg.printf("   Scan the QR at %s/pal/onboarding (WhatsApp → Settings → Linked devices). Waiting up to 3 minutes…\n", cfg.dashURL)
				deadline := time.Now().Add(3 * time.Minute)
				for time.Now().Before(deadline) {
					if cfg.checkChannels(tenant).WhatsApp == "connected" {
						break
					}
					time.Sleep(cfg.pollEvery)
				}
			}
		}
		r = cfg.checkChannels(tenant)
		cfg.printChannels(r)
	}
	doc.Step = "voice"
	doc.Channels = &palDocChannels{WhatsApp: r.WhatsApp, IMessage: r.IMessage}
	return r, palSave(client, doc)
}

// palSelectSamples mirrors selectVoiceSamples in the dashboard: only the
// owner's own 1:1 messages, deduped, capped — and nothing without consent.
func palSelectSamples(doc *palDoc, hits []map[string]any) []string {
	if !doc.mayLearnVoice() {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, h := range hits {
		fromMe, _ := h["fromMe"].(bool)
		group, _ := h["isGroup"].(bool)
		text, _ := h["text"].(string)
		text = strings.TrimSpace(text)
		if !fromMe || group || len(text) < 2 || len(text) > 400 || seen[strings.ToLower(text)] || text == "￼" {
			continue
		}
		seen[strings.ToLower(text)] = true
		out = append(out, text)
		if len(out) == 80 {
			break
		}
	}
	return out
}

func palStepVoice(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc, tenant, ownerFirst string, r palChannelReport) error {
	cfg.printf("\n3. Learn your voice\n")
	if !doc.mayLearnVoice() {
		cfg.printf("   You didn't allow reading your sent messages, so I won't. Skipping; I'll learn from drafts you approve.\n")
		doc.Step = "trust"
		doc.setVoice(palVoiceDoc{Skipped: true})
		return palSave(client, doc)
	}
	if len(r.live()) == 0 {
		r = cfg.checkChannels(tenant)
	}
	var hits []map[string]any
	now := time.Now()
	for _, ch := range r.live() {
		path := "/session/" + tenant + "/" + ch + "/search"
		for _, w := range []map[string]any{
			{"sinceMs": now.Add(-14 * 24 * time.Hour).UnixMilli(), "limit": 50},
			{"sinceMs": now.Add(-60 * 24 * time.Hour).UnixMilli(), "untilMs": now.Add(-14 * 24 * time.Hour).UnixMilli(), "limit": 50},
		} {
			var res struct {
				Results []map[string]any `json:"results"`
			}
			if _, err := cfg.bridge(ch, http.MethodPost, path, w, &res); err == nil {
				hits = append(hits, res.Results...)
			}
		}
	}
	samples := palSelectSamples(doc, hits)
	correction := ""
	for {
		var out struct {
			Profile     map[string]any `json:"profile"`
			Preview     map[string]any `json:"preview"`
			SampleCount int            `json:"sampleCount"`
		}
		err := client.Call(http.MethodPost, "/v1/pal/onboarding/voice", map[string]any{"samples": samples, "ownerName": ownerFirst, "correction": correction}, &out)
		var apiErr *internal.APIError
		if errors.As(err, &apiErr) && strings.Contains(apiErr.Body, "not_enough_samples") {
			cfg.printf("   I found only %d messages you've sent recently — not enough to learn from. Skipping; I'll learn as you text.\n", len(samples))
			doc.Step = "trust"
			doc.setVoice(palVoiceDoc{Skipped: true})
			return palSave(client, doc)
		}
		if err != nil {
			return fmt.Errorf("setup: voice: %w", err)
		}
		cfg.printf("   From %d messages you sent: %v, %v, %v\n", out.SampleCount, out.Profile["register"], out.Profile["sentenceLength"], out.Profile["warmth"])
		if pats, ok := out.Profile["patterns"].([]any); ok {
			for _, p := range pats {
				cfg.printf("     - %v\n", p)
			}
		}
		cfg.printf("   If a friend sent:  %v\n   I'd reply, as you: %v\n", out.Preview["inbound"], out.Preview["draft"])
		if !cfg.interactive() {
			return errors.New("setup: approving your voice needs an interactive terminal")
		}
		switch strings.ToLower(cfg.ask("   [a] sounds like me  [r] try again  [s] skip >")) {
		case "a":
			doc.Step = "trust"
			doc.setVoice(palVoiceDoc{Profile: out.Profile, Preview: out.Preview, SampleCount: out.SampleCount, Approved: true})
			return palSave(client, doc)
		case "s":
			doc.Step = "trust"
			doc.setVoice(palVoiceDoc{Skipped: true})
			return palSave(client, doc)
		default:
			correction = cfg.ask("   What's off? >")
		}
	}
}

func palStepTrust(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc) error {
	cfg.printf("\n4. Set trust\n")
	var prefs []struct {
		Kind string `json:"kind"`
		Mode string `json:"mode"`
	}
	if err := client.Call(http.MethodGet, "/v1/life-events/prefs", nil, &prefs); err != nil {
		return fmt.Errorf("setup: read trust settings: %w", err)
	}
	modes := map[string]string{}
	for _, p := range prefs {
		modes[p.Kind] = p.Mode
	}
	var quietStart, quietEnd *int
	if doc.Trust != nil {
		quietStart, quietEnd = doc.Trust.QuietStart, doc.Trust.QuietEnd
	}
	if !cfg.interactive() {
		return errors.New("setup: choosing trust settings needs an interactive terminal")
	}
	if text := cfg.ask("   In your words, how hands-off should I be? (Enter to keep current) >"); text != "" {
		var s struct {
			Modes      map[string]string `json:"modes"`
			QuietStart *int              `json:"quietStart"`
			QuietEnd   *int              `json:"quietEnd"`
			Why        string            `json:"why"`
		}
		if err := client.Call(http.MethodPost, "/v1/pal/onboarding/trust/suggest", map[string]string{"text": text}, &s); err != nil {
			cfg.printf("   (couldn't read that: %v — keeping current settings)\n", err)
		} else {
			for k, m := range s.Modes {
				modes[k] = m
			}
			if s.QuietStart != nil && s.QuietEnd != nil {
				quietStart, quietEnd = s.QuietStart, s.QuietEnd
			}
			if s.Why != "" {
				cfg.printf("   %s\n", s.Why)
			}
		}
	}
	for _, k := range palLifeEventKinds {
		m := modes[k]
		if m == "" {
			m = "ask"
		}
		modes[k] = m
		cfg.printf("   %-12s %s\n", k, m)
	}
	if v, ok := palAskHour(cfg, "   Quiet hours start (0-23, Enter for none) >"); ok {
		quietStart = v
		if quietStart != nil {
			quietEnd, _ = palAskHour(cfg, "   Quiet hours end (0-23) >")
		} else {
			quietEnd = nil
		}
	}
	if (quietStart == nil) != (quietEnd == nil) {
		quietStart, quietEnd = nil, nil
	}
	cfg.printf("   %s\n", palHoldsText)
	if !cfg.yesNo("   Understood, save these?", true) {
		return errors.New("setup: stopped at trust — run `pal setup` to resume")
	}
	for _, k := range palLifeEventKinds {
		if err := client.Call(http.MethodPut, "/v1/life-events/prefs", map[string]string{"kind": k, "mode": modes[k]}, nil); err != nil {
			return fmt.Errorf("setup: save %s: %w", k, err)
		}
	}
	// A 2xx per PUT is not enough: read back and compare.
	var back []struct {
		Kind string `json:"kind"`
		Mode string `json:"mode"`
	}
	if err := client.Call(http.MethodGet, "/v1/life-events/prefs", nil, &back); err != nil {
		return fmt.Errorf("setup: read back trust settings: %w", err)
	}
	if bad := palTrustMismatch(modes, back); len(bad) > 0 {
		return fmt.Errorf("setup: these trust settings didn't save: %s", strings.Join(bad, ", "))
	}
	doc.Step = "profile"
	doc.Trust = &palDocTrust{PrefsSaved: true, HoldsAcknowledged: true, QuietStart: quietStart, QuietEnd: quietEnd}
	return palSave(client, doc)
}

func palTrustMismatch(want map[string]string, back []struct {
	Kind string `json:"kind"`
	Mode string `json:"mode"`
}) []string {
	got := map[string]string{}
	for _, p := range back {
		got[p.Kind] = p.Mode
	}
	var bad []string
	for k, m := range want {
		if got[k] != m {
			bad = append(bad, k)
		}
	}
	sort.Strings(bad)
	return bad
}

// palAskHour returns (hour, answered). An empty answer is (nil, true).
func palAskHour(cfg *palSetupConfig, prompt string) (*int, bool) {
	for i := 0; i < 3; i++ {
		a := cfg.ask(prompt)
		if a == "" {
			return nil, true
		}
		if h, err := strconv.Atoi(a); err == nil && h >= 0 && h <= 23 {
			return &h, true
		}
		cfg.printf("   a whole hour from 0 to 23, please\n")
	}
	return nil, false
}

func palStepProfile(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc) error {
	cfg.printf("\n5. Your people and facts\n")
	if doc.Profile == nil {
		doc.Profile = &palDocProfile{}
	}
	if !cfg.interactive() {
		return errors.New("setup: confirming your people needs an interactive terminal")
	}
	for {
		text := cfg.ask("   Tell me about your partner, kids, key dates, close contacts (Enter when done) >")
		if text == "" {
			break
		}
		var out struct {
			Items []palDocProfileItem `json:"items"`
		}
		if err := client.Call(http.MethodPost, "/v1/pal/onboarding/profile/extract", map[string]string{"text": text}, &out); err != nil {
			cfg.printf("   (couldn't read that: %v)\n", err)
			continue
		}
		if len(out.Items) == 0 {
			cfg.printf("   I didn't find anything to save. Name the person and how they relate to you, or a date like 2017-06-03.\n")
		}
		for _, it := range out.Items {
			if !cfg.yesNo(fmt.Sprintf("   Save “%s”? (from “%s”)", palDescribeItem(it), it.Quote), false) {
				continue
			}
			it.Quote = ""
			doc.Profile.Items = palMergeItems(doc.Profile.Items, it)
			doc.Step = "profile"
			if err := palSave(client, doc); err != nil {
				return err
			}
			if doc.Profile == nil {
				doc.Profile = &palDocProfile{}
			}
		}
	}
	doc.Step = "done"
	doc.Profile.Done = true
	return palSave(client, doc)
}

func palDescribeItem(it palDocProfileItem) string {
	if it.Section == "facts" {
		return it.Key + ": " + it.Value
	}
	s := it.Key + " — " + it.Value
	if it.AddressAs != "" {
		s += " (call them " + it.AddressAs + ")"
	}
	if len(it.Never) > 0 {
		s += "; never " + strings.Join(it.Never, ", ")
	}
	return s
}

func palMergeItems(items []palDocProfileItem, it palDocProfileItem) []palDocProfileItem {
	key := it.Section + ":" + strings.ToLower(strings.TrimSpace(it.Key))
	for i := range items {
		if items[i].Section+":"+strings.ToLower(strings.TrimSpace(items[i].Key)) == key {
			items[i] = it
			return items
		}
	}
	return append(items, it)
}

func palStepDone(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc, tenant string) error {
	cfg.printf("\n6. First Brief\n")
	r := cfg.checkChannels(tenant)
	shown := false
	for _, ch := range r.live() {
		var snap struct {
			GeneratedAt *int64 `json:"generatedAt"`
			Items       []struct {
				N     int    `json:"n"`
				Icon  string `json:"icon"`
				Label string `json:"label"`
				Why   string `json:"why"`
			} `json:"items"`
		}
		if _, err := cfg.bridge(ch, http.MethodGet, "/session/"+tenant+"/attention", nil, &snap); err != nil || snap.GeneratedAt == nil {
			continue
		}
		shown = true
		if len(snap.Items) == 0 {
			cfg.printf("   Nothing needs you right now (%s).\n", ch)
		}
		for _, it := range snap.Items {
			line := fmt.Sprintf("   %s %d. %s", it.Icon, it.N, it.Label)
			if it.Why != "" {
				line += " · " + it.Why
			}
			cfg.printf("%s\n", line)
		}
		break
	}
	if !shown {
		where := "a connected channel"
		if live := r.live(); len(live) > 0 {
			where = live[0]
		}
		cfg.printf("   Text ? to yourself on %s — your Brief is built on demand and shows up there.\n", where)
	}
	cfg.printf("\n%sYou're set.%s\n", colorGreen, colorReset)
	if cfg.interactive() && cfg.yesNo("   Apply this setup to this Mac's bridge config now?", true) {
		return palApply(cfg, client, doc)
	}
	cfg.printf("   Apply later with: pal setup --apply\n")
	return nil
}

// ---- --apply: write the setup into this Mac's bridge config ---------------------

// palStateDir mirrors packages/bridge-core/src/state-dir.ts: PAL_STATE_DIR,
// else ~/.pal.
func palStateDir() string {
	if v := envFirst("PAL_STATE_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pal")
}

func palApply(cfg *palSetupConfig, client *internal.RESTClient, doc *palDoc) error {
	cfg.defaults()
	if doc.ResumeStep != "done" {
		return fmt.Errorf("setup: finish setup first (next step: %s) — run `pal setup`", doc.ResumeStep)
	}
	stateDir := cfg.stateDir
	if stateDir == "" {
		stateDir = palStateDir()
	}
	profilePath := cfg.profilePath
	if profilePath == "" {
		profilePath = envFirst("PAL_OWNER_PROFILE")
	}
	if profilePath == "" {
		profilePath = filepath.Join(stateDir, "owner-profile.md")
	}

	var rendered struct {
		Facts         []string `json:"facts"`
		Relationships []string `json:"relationships"`
	}
	if err := client.Call(http.MethodGet, "/v1/pal/onboarding/profile", nil, &rendered); err != nil {
		return fmt.Errorf("setup: read profile: %w", err)
	}
	env := map[string]string{}
	if doc.Trust != nil && doc.Trust.QuietStart != nil && doc.Trust.QuietEnd != nil {
		env["PAL_QUIET_START"] = strconv.Itoa(*doc.Trust.QuietStart)
		env["PAL_QUIET_END"] = strconv.Itoa(*doc.Trust.QuietEnd)
	}
	if doc.voice().Approved {
		env["PAL_VOICE_REASONING"] = "1"
	}

	cfg.printf("\nApplying to this Mac\n")
	if len(rendered.Facts)+len(rendered.Relationships) > 0 {
		changed, err := palMergeProfileFile(profilePath, rendered.Facts, rendered.Relationships)
		if err != nil {
			return err
		}
		cfg.printf("   %s✓%s %s (%d line(s) added or updated)\n", colorGreen, colorReset, profilePath, changed)
	}
	if len(env) > 0 {
		envPath := filepath.Join(stateDir, "bridge.env")
		if err := palUpsertEnvFile(envPath, env); err != nil {
			return err
		}
		keys := make([]string, 0, len(env))
		for k := range env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		cfg.printf("   %s✓%s %s (%s)\n", colorGreen, colorReset, envPath, strings.Join(keys, ", "))
	}
	cfg.printf("   Restart the bridges so they pick this up (e.g. `make deploy-local FORCE=1`).\n")
	return nil
}

// palMergeProfileFile merges lines into the "## Facts" and "## Relationships"
// sections: a line whose key already exists is replaced (the owner just
// confirmed it), a new key is appended, every other byte is kept. Backs the
// file up first, writes 0600, and re-reads to verify.
func palMergeProfileFile(path string, facts, rels []string) (int, error) {
	orig, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return 0, fmt.Errorf("setup: read %s: %w", path, err)
	}
	text := string(orig)
	if text == "" {
		text = "# Owner profile\n"
	}
	changed := 0
	text, n := palMergeSection(text, "Facts", facts)
	changed += n
	text, n = palMergeSection(text, "Relationships", rels)
	changed += n
	if changed == 0 {
		return 0, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return 0, fmt.Errorf("setup: %w", err)
	}
	if len(orig) > 0 {
		if err := os.WriteFile(fmt.Sprintf("%s.bak-%d", path, time.Now().Unix()), orig, 0o600); err != nil {
			return 0, fmt.Errorf("setup: back up %s: %w", path, err)
		}
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return 0, fmt.Errorf("setup: write %s: %w", path, err)
	}
	back, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("setup: verify %s: %w", path, err)
	}
	for _, l := range append(append([]string{}, facts...), rels...) {
		if !strings.Contains(string(back), l) {
			return 0, fmt.Errorf("setup: verify %s: %q missing after write", path, l)
		}
	}
	return changed, nil
}

func palLineKey(line string) string {
	l := strings.TrimSpace(line)
	l = strings.TrimLeft(l, "-* ")
	if i := strings.Index(l, ":"); i > 0 {
		return strings.ToLower(strings.TrimSpace(l[:i]))
	}
	return ""
}

func palMergeSection(text, section string, lines []string) (string, int) {
	if len(lines) == 0 {
		return text, 0
	}
	all := strings.Split(text, "\n")
	start := -1
	for i, l := range all {
		if strings.EqualFold(strings.TrimSpace(l), "## "+section) {
			start = i
			break
		}
	}
	if start < 0 {
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		return text + "\n## " + section + "\n" + strings.Join(lines, "\n") + "\n", len(lines)
	}
	end := len(all)
	for i := start + 1; i < len(all); i++ {
		if strings.HasPrefix(strings.TrimSpace(all[i]), "## ") {
			end = i
			break
		}
	}
	body := append([]string{}, all[start+1:end]...)
	changed := 0
	for _, nl := range lines {
		k := palLineKey(nl)
		replaced := false
		for i, ol := range body {
			if k != "" && palLineKey(ol) == k && !strings.HasPrefix(strings.TrimSpace(ol), "#") {
				if strings.TrimSpace(ol) != nl {
					body[i] = nl
					changed++
				}
				replaced = true
				break
			}
		}
		if !replaced {
			// Insert after the last non-blank line of the section.
			at := len(body)
			for at > 0 && strings.TrimSpace(body[at-1]) == "" {
				at--
			}
			body = append(body[:at], append([]string{nl}, body[at:]...)...)
			changed++
		}
	}
	out := append(append(append([]string{}, all[:start+1]...), body...), all[end:]...)
	return strings.Join(out, "\n"), changed
}

// palUpsertEnvFile sets KEY=value lines in a shell env file, keeping every
// other line. Backs up, writes 0600.
func palUpsertEnvFile(path string, kv map[string]string) error {
	orig, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("setup: read %s: %w", path, err)
	}
	lines := []string{}
	if len(orig) > 0 {
		lines = strings.Split(strings.TrimRight(string(orig), "\n"), "\n")
	}
	done := map[string]bool{}
	for i, l := range lines {
		t := strings.TrimPrefix(strings.TrimSpace(l), "export ")
		for k, v := range kv {
			if strings.HasPrefix(t, k+"=") {
				lines[i] = k + "=" + v
				done[k] = true
			}
		}
	}
	keys := make([]string, 0, len(kv))
	for k := range kv {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !done[k] {
			lines = append(lines, k+"="+kv[k])
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("setup: %w", err)
	}
	if len(orig) > 0 {
		if err := os.WriteFile(fmt.Sprintf("%s.bak-%d", path, time.Now().Unix()), orig, 0o600); err != nil {
			return fmt.Errorf("setup: back up %s: %w", path, err)
		}
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return fmt.Errorf("setup: write %s: %w", path, err)
	}
	return nil
}
