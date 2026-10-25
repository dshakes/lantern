package handlers

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// Every function that drives the tool loop must install the tool-usage
// accumulator, or web_search spend is silently dropped from that path's
// usage/budget accounting (the /v1/completions tool loop shipped without it).
func TestCallLLMWithTools_EveryCallerAccountsToolSpend(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	// Pass-through helpers forward the caller's ctx (withToolUsage reuses an
	// accumulator already on it); the OUTER caller is what must install one.
	passThrough := map[string]bool{"callLLMWithFailover": true}
	fset := token.NewFileSet()
	callers := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Name.Name == "callLLMWithTools" || passThrough[fn.Name.Name] {
				continue
			}
			calls := map[string]bool{}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if c, ok := n.(*ast.CallExpr); ok {
					switch f := c.Fun.(type) {
					case *ast.SelectorExpr:
						calls[f.Sel.Name] = true
					case *ast.Ident:
						calls[f.Name] = true
					}
				}
				return true
			})
			if !calls["callLLMWithTools"] {
				continue
			}
			callers++
			if !calls["withToolUsage"] {
				t.Errorf("%s (%s) calls callLLMWithTools without withToolUsage — tool spend is dropped", fn.Name.Name, name)
			}
		}
	}
	if callers == 0 {
		t.Fatal("found no callLLMWithTools callers — the invariant scan is broken")
	}
}
