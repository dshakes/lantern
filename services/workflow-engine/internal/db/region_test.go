package db

import (
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestApplyRegionSession(t *testing.T) {
	for _, tc := range []struct {
		name, region, epoch string
		want                map[string]string
		wantErr             bool
	}{
		{name: "unset adds nothing", want: map[string]string{}},
		{name: "both", region: "us-east-1", epoch: "2", want: map[string]string{"pal.region": "us-east-1", "pal.fence_epoch": "2"}},
		{name: "bad region", region: "Us East", wantErr: true},
		{name: "bad epoch", epoch: "0", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PAL_REGION", tc.region)
			t.Setenv("PAL_FENCE_EPOCH", tc.epoch)
			cc, err := pgx.ParseConfig("postgres://u@localhost/db")
			if err != nil {
				t.Fatal(err)
			}
			err = ApplyRegionSession(cc)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			for k, v := range tc.want {
				if cc.RuntimeParams[k] != v {
					t.Fatalf("%s = %q, want %q", k, cc.RuntimeParams[k], v)
				}
			}
			if _, ok := cc.RuntimeParams["pal.region"]; ok && tc.region == "" {
				t.Fatalf("unexpected pal.region")
			}
		})
	}
}
