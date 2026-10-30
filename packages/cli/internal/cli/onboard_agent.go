package cli

// onboard_agent.go — the conversational mode of `pal onboard` and `pal setup`
// (ADR 0051): the terminal twin of the dashboard's onboarding chat, driving the
// SAME server agent (POST /v1/onboarding/agent/turn). The user types in their
// own words; the agent replies, calls server tools, and asks this CLI to run
// the parts only a local client can: the masked key prompt (the key goes to
// the settings endpoints, never into the chat), the owner's own consent
// keypress, live bridge checks on this Mac, voice sampling and confirmations.
//
// Default on a terminal; --steps keeps the step wizard. --yes / non-TTY never
// enters chat mode (and so never prompts for consent). When the agent can't
// reach the model (mode "fallback") or the server has no agent endpoint, the
// caller drops to the step wizard and says so.

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
)

// errChatFallback: the conversation can't continue; run the step wizard.
var errChatFallback = errors.New("onboarding agent unavailable — continuing step by step")

type chatMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
	Tool string `json:"tool"`
	OK   *bool  `json:"ok"`
}

type chatAction struct {
	ID   string `json:"id"`
	Tool string `json:"tool"`
	Args struct {
		Provider   string            `json:"provider"`
		Correction string            `json:"correction"`
		Modes      map[string]string `json:"modes"`
		QuietStart *int              `json:"quietStart"`
		QuietEnd   *int              `json:"quietEnd"`
		Why        string            `json:"why"`
		Items      []palDocProfileItem
	} `json:"args"`
}

type chatToolCall struct {
	Tool    string `json:"tool"`
	OK      bool   `json:"ok"`
	Refused bool   `json:"refused"`
	Summary string `json:"summary"`
}

type chatTurn struct {
	Mode           string         `json:"mode"`
	Reply          string         `json:"reply"`
	Actions        []chatAction   `json:"actions"`
	ToolCalls      []chatToolCall `json:"toolCalls"`
	Messages       []chatMessage  `json:"messages"`
	FallbackReason string         `json:"fallbackReason"`
	Facts          struct {
		Phase string `json:"phase"`
	} `json:"facts"`
}

type chatResult struct {
	ActionID string `json:"actionId"`
	Tool     string `json:"tool"`
	OK       bool   `json:"ok"`
	Summary  string `json:"summary"`
	Channels *struct {
		WhatsApp string `json:"whatsapp"`
		IMessage string `json:"imessage"`
	} `json:"channels,omitempty"`
}

// chatSession is one conversational run. pal (bridge access) is set only for
// the pal product.
type chatSession struct {
	product    string
	client     *internal.RESTClient
	restURL    string
	token      string
	reader     onboardReader
	out        io.Writer
	pal        *palSetupConfig
	tenant     string
	ownerFirst string
	briefShown bool
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

var sleep = time.Sleep

func (s *chatSession) printf(format string, a ...any) { fmt.Fprintf(s.out, format, a...) }

func (s *chatSession) line(prompt string) (string, error) {
	s.printf("%s", prompt)
	l, err := s.reader.ReadLine()
	return strings.TrimSpace(l), err
}

func (s *chatSession) turn(body map[string]any) (*chatTurn, error) {
	body["product"] = s.product
	var out chatTurn
	if err := s.client.Call(http.MethodPost, "/v1/onboarding/agent/turn", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// runOnboardingChat drives the conversation until setup is done or the user
// leaves (progress is server-side; running the command again resumes).
func runOnboardingChat(s *chatSession) error {
	var existing chatTurn
	if err := s.client.Call(http.MethodGet, "/v1/onboarding/agent?product="+s.product, nil, &existing); err != nil {
		var apiErr *internal.APIError
		if errors.As(err, &apiErr) && (apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusMethodNotAllowed) {
			return errChatFallback // older server without the agent
		}
		return fmt.Errorf("onboarding: read conversation: %w", err)
	}
	s.printf("%sTalk to the setup agent in your own words. Enter on an empty line (or q) to stop — your progress is saved.%s\n\n", colorDim, colorReset)
	event := "start"
	if len(existing.Messages) > 0 {
		event = "resume"
		s.printf("%s(picking up where you left off)%s\n", colorDim, colorReset)
	}
	t, err := s.turn(map[string]any{"event": event})
	for i := 0; i < 200; i++ {
		if err != nil {
			return fmt.Errorf("onboarding agent: %w", err)
		}
		s.show(t)
		if t.Mode == "fallback" {
			s.printf("\n%s%s%s\n", colorYellow, orDefault(t.FallbackReason, "the onboarding agent couldn't reach the model"), colorReset)
			return errChatFallback
		}
		if len(t.Actions) > 0 {
			res := s.runAction(t.Actions[0])
			t, err = s.turn(map[string]any{"results": []chatResult{res}})
			continue
		}
		if s.finished(t) {
			return nil
		}
		msg, rerr := s.line("\n" + colorCyan + "you › " + colorReset)
		if rerr != nil || msg == "" || msg == "q" || msg == "quit" || msg == "exit" {
			s.printf("Stopped — run the command again to pick up here.\n")
			return nil
		}
		t, err = s.turn(map[string]any{"message": msg})
	}
	return errors.New("onboarding: the conversation did not converge")
}

func orDefault(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

func (s *chatSession) finished(t *chatTurn) bool {
	if s.product == "runtime" {
		return t.Facts.Phase == "done"
	}
	return s.briefShown // pal ends after the first Brief, or when the user stops
}

func (s *chatSession) show(t *chatTurn) {
	for _, c := range t.ToolCalls {
		mark := colorGreen + "✓" + colorReset
		if c.Refused {
			mark = colorYellow + "⊘" + colorReset
		} else if !c.OK {
			mark = colorRed + "✗" + colorReset
		}
		s.printf("   %s %s%s%s\n", mark, colorDim, c.Summary, colorReset)
	}
	if strings.TrimSpace(t.Reply) != "" {
		name := "pal"
		s.printf("\n%s%s ›%s %s\n", colorGreen, name, colorReset, t.Reply)
	}
}

// ---- client actions -----------------------------------------------------------

func (s *chatSession) runAction(a chatAction) chatResult {
	res := chatResult{ActionID: a.ID, Tool: a.Tool}
	switch a.Tool {
	case "collect_provider_key":
		res.OK, res.Summary = s.actionKey(a.Args.Provider)
	case "ask_consent":
		res.OK, res.Summary = s.actionConsent()
	case "check_channels", "start_imessage", "pair_whatsapp":
		res.OK, res.Summary, res.Channels = s.actionChannels(a.Tool)
	case "learn_voice":
		res.OK, res.Summary = s.actionVoice()
	case "confirm_trust":
		res.OK, res.Summary = s.actionTrust(a)
	case "confirm_profile":
		res.OK, res.Summary = s.actionProfile(a.Args.Items)
	case "show_brief":
		res.OK, res.Summary = s.actionBrief()
	default:
		res.Summary = "this CLI can't run " + a.Tool + " — use the dashboard"
	}
	return res
}

// actionKey: masked prompt; the key goes only to the settings endpoints.
func (s *chatSession) actionKey(suggested string) (bool, string) {
	provider := suggested
	if provider != "openai" && provider != "anthropic" {
		p, _ := s.line("   Provider [anthropic/openai] (anthropic) › ")
		provider = strings.ToLower(p)
		if provider != "openai" {
			provider = "anthropic"
		}
	}
	s.printf("   %s API key (hidden, never added to the chat) › ", provider)
	key, err := s.reader.ReadMasked()
	key = strings.TrimSpace(key)
	if err != nil || key == "" {
		return false, "no key entered"
	}
	if err := configureProvider(s.client, provider, key); err != nil {
		return false, "saving the " + provider + " key failed: " + err.Error()
	}
	if err := testProvider(s.restURL, s.token, provider); err != nil {
		return false, "the " + provider + " key was saved but its test call failed: " + err.Error()
	}
	return true, "the " + provider + " key was saved and passed a real test call"
}

// actionConsent: only an explicit "y" from the owner, at this terminal.
func (s *chatSession) actionConsent() (bool, string) {
	cfg := s.pal
	cfg.printf("\n   pal may read your iMessage/WhatsApp on this Mac and reply as you, sending conversation text to your own model provider. You can mute or stop it any time.\n")
	if !cfg.yesNo("   Do you agree?", false) {
		return false, "the owner did not agree"
	}
	voice := cfg.yesNo("   Optional: learn your voice from messages you've sent (read once, not stored)?", false)
	doc, err := s.palDoc()
	if err != nil {
		return false, err.Error()
	}
	if doc.Step == "" || doc.Step == "welcome" {
		doc.Step = "channels"
	}
	doc.Consent = &palDocConsent{Version: palConsentVersion, AcceptedAt: nowRFC3339(), VoiceSampling: voice}
	if err := palSave(s.client, doc); err != nil {
		return false, err.Error()
	}
	if voice {
		return true, "the owner agreed and opted in to voice learning"
	}
	return true, "the owner agreed; voice learning: not allowed"
}

func (s *chatSession) palDoc() (*palDoc, error) {
	var doc palDoc
	if err := s.client.Call(http.MethodGet, "/v1/pal/onboarding", nil, &doc); err != nil {
		return nil, fmt.Errorf("read progress: %w", err)
	}
	return &doc, nil
}

func (s *chatSession) actionChannels(tool string) (bool, string, *struct {
	WhatsApp string `json:"whatsapp"`
	IMessage string `json:"imessage"`
}) {
	cfg := s.pal
	switch tool {
	case "start_imessage":
		_, _ = cfg.bridge("imessage", http.MethodPost, "/session/"+s.tenant+"/start", nil, nil)
	case "pair_whatsapp":
		if _, err := cfg.bridge("whatsapp", http.MethodPost, "/session/"+s.tenant+"/start", nil, nil); err == nil {
			cfg.printf("   Scan the QR at %s/pal/onboarding (WhatsApp → Settings → Linked devices). Waiting up to 3 minutes…\n", cfg.dashURL)
			for deadline := time.Now().Add(3 * time.Minute); time.Now().Before(deadline); {
				if cfg.checkChannels(s.tenant).WhatsApp == "connected" {
					break
				}
				sleep(cfg.pollEvery)
			}
		}
	}
	r := cfg.checkChannels(s.tenant)
	cfg.printChannels(r)
	ch := &struct {
		WhatsApp string `json:"whatsapp"`
		IMessage string `json:"imessage"`
	}{WhatsApp: r.WhatsApp, IMessage: r.IMessage}
	return r.verified(), fmt.Sprintf("iMessage %s; WhatsApp %s", r.IMessage, r.WhatsApp), ch
}

func (s *chatSession) actionVoice() (bool, string) {
	doc, err := s.palDoc()
	if err != nil {
		return false, err.Error()
	}
	r := s.pal.checkChannels(s.tenant)
	if err := palStepVoice(s.pal, s.client, doc, s.tenant, s.ownerFirst, r); err != nil {
		return false, "voice: " + err.Error()
	}
	v := doc.voice()
	switch {
	case v.Approved:
		return true, fmt.Sprintf("the owner approved the voice (%v, %v)", v.Profile["register"], v.Profile["warmth"])
	case v.Skipped:
		return true, "voice learning skipped"
	}
	return false, "voice not saved"
}

func (s *chatSession) actionTrust(a chatAction) (bool, string) {
	cfg := s.pal
	var prefs []struct {
		Kind string `json:"kind"`
		Mode string `json:"mode"`
	}
	if err := s.client.Call(http.MethodGet, "/v1/life-events/prefs", nil, &prefs); err != nil {
		return false, "couldn't read trust settings: " + err.Error()
	}
	modes := map[string]string{}
	for _, p := range prefs {
		modes[p.Kind] = p.Mode
	}
	for k, m := range a.Args.Modes {
		modes[k] = m
	}
	if a.Args.Why != "" {
		cfg.printf("   %s\n", a.Args.Why)
	}
	for _, k := range palLifeEventKinds {
		if modes[k] == "" {
			modes[k] = "ask"
		}
		cfg.printf("   %-12s %s\n", k, modes[k])
	}
	qs, qe := a.Args.QuietStart, a.Args.QuietEnd
	if qs != nil && qe != nil {
		cfg.printf("   quiet hours  %d:00–%d:00\n", *qs, *qe)
	} else {
		qs, qe = nil, nil
	}
	cfg.printf("   %s\n", palHoldsText)
	if !cfg.yesNo("   Understood — save these?", false) {
		return false, "the owner didn't save these settings (they can say what to change)"
	}
	doc, err := s.palDoc()
	if err != nil {
		return false, err.Error()
	}
	if err := palSaveTrust(s.client, doc, modes, qs, qe); err != nil {
		return false, err.Error()
	}
	return true, "trust saved and read back: " + describeModeMap(modes)
}

func describeModeMap(m map[string]string) string {
	parts := make([]string, 0, len(m))
	for _, k := range palLifeEventKinds {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ", ")
}

func (s *chatSession) actionProfile(items []palDocProfileItem) (bool, string) {
	cfg := s.pal
	var saved []string
	for _, it := range items {
		if !cfg.yesNo(fmt.Sprintf("   Save “%s”? (from “%s”)", palDescribeItem(it), it.Quote), false) {
			continue
		}
		doc, err := s.palDoc()
		if err != nil {
			return false, err.Error()
		}
		if doc.Profile == nil {
			doc.Profile = &palDocProfile{}
		}
		it.Quote = ""
		doc.Profile.Items = palMergeItems(doc.Profile.Items, it)
		doc.Step = "profile"
		if err := palSave(s.client, doc); err != nil {
			return false, err.Error()
		}
		saved = append(saved, palDescribeItem(it))
	}
	if len(saved) == 0 {
		return true, "the owner saved none of the proposed items"
	}
	return true, "confirmed and saved: " + strings.Join(saved, "; ")
}

func (s *chatSession) actionBrief() (bool, string) {
	doc, err := s.palDoc()
	if err != nil {
		return false, err.Error()
	}
	if err := palStepDone(s.pal, s.client, doc, s.tenant); err != nil {
		return false, err.Error()
	}
	s.briefShown = true
	return true, "Brief shown in the terminal"
}
