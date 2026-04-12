package cli

import (
	"fmt"
	"io"
	"os"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
)

func newLogsCommand() *cobra.Command {
	var follow bool

	cmd := &cobra.Command{
		Use:   "logs <run-id>",
		Short: "Stream run events",
		Long:  "Stream events for a run. Events are pretty-printed with colors indicating event type.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			runID := args[0]

			clients, err := internal.Dial(clientConfig())
			if err != nil {
				return err
			}
			defer clients.Close()

			stream, err := clients.Runs.StreamRunEvents(cmd.Context(), &lanternv1.StreamRunEventsRequest{
				RunId: runID,
				Live:  follow,
			})
			if err != nil {
				return fmt.Errorf("stream events: %w", err)
			}

			for {
				event, err := stream.Recv()
				if err == io.EOF {
					return nil
				}
				if err != nil {
					return fmt.Errorf("stream recv: %w", err)
				}

				if isJSON() {
					if err := printJSON(streamEventToMap(event)); err != nil {
						fmt.Fprintf(os.Stderr, "%sfailed to print event: %v%s\n", colorRed, err, colorReset)
					}
					continue
				}

				printStreamEvent(event)

				// Stop on stream end unless following.
				if _, ok := event.GetPayload().(*lanternv1.StreamEvent_End); ok && !follow {
					return nil
				}
			}
		},
	}

	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "Follow live events (keep connection open)")

	return cmd
}
