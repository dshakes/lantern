package handlers

import "testing"

func TestCanonicalHandle(t *testing.T) {
	cases := []struct {
		name        string
		channel     string
		handle      string
		wantChannel string
		wantHandle  string
		wantPhone   bool
	}{
		{"whatsapp jid", "whatsapp", "15125551234@s.whatsapp.net", "whatsapp", "15125551234", true},
		{"sms plus", "sms", "+1 (512) 555-1234", "sms", "15125551234", true},
		{"voice digits", "voice", "15125551234", "voice", "15125551234", true},
		{"imessage phone", "imessage", "+15125551234", "imessage", "15125551234", true},
		{"imessage email", "imessage", "Foo@iCloud.com", "email", "foo@icloud.com", false},
		{"email channel", "email", "Bar@Example.COM", "email", "bar@example.com", false},
		{"gmail aliases to email", "gmail", "Baz@gmail.com", "email", "baz@gmail.com", false},
		{"phone with spaces", "phone", "  1-512-555-1234 ", "phone", "15125551234", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			chn, hdl, isPhone := canonicalHandle(tc.channel, tc.handle)
			if chn != tc.wantChannel || hdl != tc.wantHandle || isPhone != tc.wantPhone {
				t.Errorf("canonicalHandle(%q,%q) = (%q,%q,%v), want (%q,%q,%v)",
					tc.channel, tc.handle, chn, hdl, isPhone,
					tc.wantChannel, tc.wantHandle, tc.wantPhone)
			}
		})
	}
}

// The crux of cross-channel unification: the same number reached over
// different phone-like channels must normalize to the same digits, so a
// digit lookup across phoneLikeChannels resolves them to one person.
func TestPhoneLikeChannelsUnify(t *testing.T) {
	inputs := []struct{ channel, handle string }{
		{"whatsapp", "15125551234@s.whatsapp.net"},
		{"sms", "+1 (512) 555-1234"},
		{"imessage", "+15125551234"},
		{"voice", "15125551234"},
		{"phone", "1.512.555.1234"},
	}
	want := "15125551234"
	for _, in := range inputs {
		_, hdl, isPhone := canonicalHandle(in.channel, in.handle)
		if !isPhone {
			t.Errorf("%s:%s not treated as phone", in.channel, in.handle)
		}
		if hdl != want {
			t.Errorf("%s:%s normalized to %q, want %q", in.channel, in.handle, hdl, want)
		}
	}
}

func TestPhoneHandleVariants(t *testing.T) {
	got := phoneHandleVariants("15125551234")
	wantSet := map[string]bool{
		"15125551234":                 true,
		"15125551234@s.whatsapp.net":  true,
		"+15125551234":                true,
		"+15125551234@s.whatsapp.net": true,
	}
	if len(got) != len(wantSet) {
		t.Fatalf("got %d variants, want %d: %v", len(got), len(wantSet), got)
	}
	for _, v := range got {
		if !wantSet[v] {
			t.Errorf("unexpected variant %q", v)
		}
	}
	if phoneHandleVariants("") != nil {
		t.Error("empty digits should yield nil variants")
	}
}

func TestPhoneLikeChannelsList(t *testing.T) {
	list := phoneLikeChannelsList()
	if len(list) != len(phoneLikeChannels) {
		t.Fatalf("list len %d != map len %d", len(list), len(phoneLikeChannels))
	}
	for _, c := range list {
		if !phoneLikeChannels[c] {
			t.Errorf("list has %q not in phoneLikeChannels", c)
		}
	}
}
