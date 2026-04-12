package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"text/tabwriter"
)

// ANSI color codes for terminal output.
const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorBlue   = "\033[34m"
	colorDim    = "\033[2m"
	colorCyan   = "\033[36m"
)

// printTable writes an aligned table to stdout using tabwriter.
func printTable(headers []string, rows [][]string) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	// Print header.
	for i, h := range headers {
		if i > 0 {
			fmt.Fprint(w, "\t")
		}
		fmt.Fprint(w, h)
	}
	fmt.Fprintln(w)

	// Print rows.
	for _, row := range rows {
		for i, col := range row {
			if i > 0 {
				fmt.Fprint(w, "\t")
			}
			fmt.Fprint(w, col)
		}
		fmt.Fprintln(w)
	}
	w.Flush()
}

// printJSON marshals v as indented JSON and writes it to stdout.
func printJSON(v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal json: %w", err)
	}
	fmt.Println(string(data))
	return nil
}

// printSuccess prints a green success message to stderr.
func printSuccess(msg string) {
	fmt.Fprintf(os.Stderr, "%s✓ %s%s\n", colorGreen, msg, colorReset)
}

// printError prints a red error message to stderr.
func printError(msg string) {
	fmt.Fprintf(os.Stderr, "%s✗ %s%s\n", colorRed, msg, colorReset)
}

// printWarning prints a yellow warning message to stderr.
func printWarning(msg string) {
	fmt.Fprintf(os.Stderr, "%s! %s%s\n", colorYellow, msg, colorReset)
}

// printInfo prints a blue informational message to stderr.
func printInfo(msg string) {
	fmt.Fprintf(os.Stderr, "%si %s%s\n", colorBlue, msg, colorReset)
}
