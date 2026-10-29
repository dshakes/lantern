#!/usr/bin/env bash
# brand-check.sh — count `lantern` references left after the PAL rename (ADR 0032).
#
#   scripts/brand-check.sh            # --report (default): counts by top-level dir
#   scripts/brand-check.sh --enforce  # same, exit 1 if anything outside the allowlist remains
#
# Scans git-tracked text files (case-insensitive), skipping lockfiles. Hits
# matched by scripts/brand-allowlist.txt are not counted. Allowlist format, one
# entry per line, `<perl regex> # <reason>` (reason required):
#   <regex>        stripped from every content line AND every file path before counting
#   path:<regex>   whole file excluded (content and path)
# Patterns are case-sensitive; prefix (?i) to relax one. Path hits (a tracked
# file whose path still contains `lantern`) are counted separately.
set -euo pipefail

mode=report
case "${1:-}" in
  "" | --report) ;;
  --enforce) mode=enforce ;;
  *) echo "usage: $0 [--report|--enforce]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"
allow="scripts/brand-allowlist.txt"
[[ -f "$allow" ]] || { echo "brand-check: missing $allow" >&2; exit 2; }

lockfiles=(':!:*.lock' ':!:**/package-lock.json' ':!:package-lock.json' ':!:**/go.sum'
  ':!:go.sum' ':!:**/pnpm-lock.yaml' ':!:pnpm-lock.yaml')

# Two streams into one perl pass: "C\t<path>\t<line>" content hits, "P\t<path>" paths.
{
  git grep -I -i --null -e lantern -- . "${lockfiles[@]}" | perl -ne '
    chomp; my ($p, $l) = split /\0/, $_, 2; print "C\t$p\t$l\n" if defined $l' || true
  git ls-files -- . "${lockfiles[@]}" | grep -i lantern | sed 's/^/P\t/' || true
} | ALLOW="$allow" MODE="$mode" perl -e '
  my (@content, @path);
  open my $fh, "<", $ENV{ALLOW} or die "brand-check: $ENV{ALLOW}: $!\n";
  while (my $line = <$fh>) {
    chomp $line;
    next if $line =~ /^\s*(#|$)/;
    my ($re, $reason) = $line =~ /^(.*?)\s+#\s+(\S.*)$/
      or die "brand-check: $ENV{ALLOW}:$.: need \"<regex> # <reason>\"\n";
    if ($re =~ s/^path://) { push @path, qr/$re/ } else { push @content, qr/$re/ }
  }
  my (%hits, %files, %paths, $total, $ptotal);
  LINE: while (<STDIN>) {
    chomp;
    my ($kind, $p, $text) = split /\t/, $_, 3;
    for my $re (@path) { next LINE if $p =~ $re }
    my $s = $kind eq "C" ? $text : $p;
    $s =~ s/$_//g for @content;
    my $n = () = $s =~ /lantern/gi;
    next unless $n;
    my ($top) = $p =~ m{^([^/]+/?)};
    if ($kind eq "C") { $hits{$top} += $n; $files{$top}{$p} = 1; $total += $n }
    else { $paths{$top}++; $ptotal++ }
  }
  my %tops = map { $_ => 1 } keys %hits, keys %paths;
  printf "%-28s %8s %7s %7s\n", "top-level", "hits", "files", "paths";
  for my $t (sort { ($hits{$b} // 0) <=> ($hits{$a} // 0) || $a cmp $b } keys %tops) {
    printf "%-28s %8d %7d %7d\n", $t, $hits{$t} // 0, scalar keys %{ $files{$t} // {} }, $paths{$t} // 0;
  }
  my $nfiles = 0; $nfiles += keys %{ $files{$_} } for keys %files;
  printf "%-28s %8d %7d %7d\n", "TOTAL", $total // 0, $nfiles, $ptotal // 0;
  if ($ENV{MODE} eq "enforce" && (($total // 0) + ($ptotal // 0)) > 0) {
    print STDERR "brand-check: `lantern` references remain outside scripts/brand-allowlist.txt\n";
    exit 1;
  }
'
