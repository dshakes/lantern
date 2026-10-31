#!/usr/bin/env bash
# brand-check.sh — fail on any reference to the previous brand (ADR 0032).
#
#   scripts/brand-check.sh            # --report (default): counts by top-level dir
#   scripts/brand-check.sh --enforce  # same, exit 1 if anything outside the allowlist remains
#
# Scans every git-tracked text file (case-insensitive), lockfiles included. Hits
# matched by scripts/brand-allowlist.txt are not counted. Allowlist format, one
# entry per line, `<perl regex> # <reason>` (reason required):
#   <regex>                     stripped from every content line AND file path before counting
#   scope:<path-regex> <regex>  same, but only in files whose path matches <path-regex>
#   path:<regex>                whole file excluded (content and path)
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


# grep-family exit 1 means "no match"; anything above it is a real failure
# (not a repo, bad pathspec, I/O) and must fail the check, not read as clean.
content_hits() {
  local rc=0
  git grep -I -i --null -e lantern -- . || rc=$?
  [[ $rc -le 1 ]] || { echo "brand-check: git grep failed (exit $rc)" >&2; return "$rc"; }
}
path_hits() {
  local files rc=0
  files="$(git ls-files -- .)" || { echo "brand-check: git ls-files failed" >&2; return 2; }
  grep -i lantern <<<"$files" || rc=$?
  [[ $rc -le 1 ]] || { echo "brand-check: grep failed (exit $rc)" >&2; return "$rc"; }
}

# Two streams into one perl pass: "C\t<path>\t<line>" content hits, "P\t<path>" paths.
{
  content_hits | perl -ne '
    chomp; my ($p, $l) = split /\0/, $_, 2; print "C\t$p\t$l\n" if defined $l'
  path_hits | sed 's/^/P\t/'
} | ALLOW="$allow" MODE="$mode" perl -e '
  my (@content, @path, @scoped);
  open my $fh, "<", $ENV{ALLOW} or die "brand-check: $ENV{ALLOW}: $!\n";
  while (my $line = <$fh>) {
    chomp $line;
    next if $line =~ /^\s*(#|$)/;
    my ($re, $reason) = $line =~ /^(.*?)\s+#\s+(\S.*)$/
      or die "brand-check: $ENV{ALLOW}:$.: need \"<regex> # <reason>\"\n";
    if ($re =~ s/^path://) { push @path, qr/$re/ }
    elsif ($re =~ /^scope:(\S+)\s+(.+)$/) { push @scoped, [qr/$1/, qr/$2/] }
    else { push @content, qr/$re/ }
  }
  my (%hits, %files, %paths, $total, $ptotal);
  LINE: while (<STDIN>) {
    chomp;
    my ($kind, $p, $text) = split /\t/, $_, 3;
    for my $re (@path) { next LINE if $p =~ $re }
    my $s = $kind eq "C" ? $text : $p;
    $s =~ s/$_//g for @content;
    for (@scoped) { my ($in, $re) = @$_; $s =~ s/$re//g if $p =~ $in }
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

# Third-party domains. pal.run and pal.dev are owned by strangers: a default
# URL, copy button or e-mail on them would send users' API keys, agent tokens
# or mail to someone else's server. Hosts only — K8s label keys (pal.dev/<key>)
# are names, never contacted. Use
# localhost / a derived origin in code, RFC 2606 pal.example.com in examples,
# the docs site https://dshakes.github.io/pal for docs links.
rc=0
domains="$(git grep -n -I -P \
  '((https?|wss?)://|@)([a-z0-9-]+\.)*pal\.(run|dev)\b(?![._-])|\b[a-z0-9-]+\.pal\.(run|dev)\b(?![._-])|(?<![\w./@-])pal\.run(?![\w.-])' \
  -- . ':!scripts/brand-check.sh' ':!scripts/zero-lantern/**' ':!scripts/cutover/**' ':!docs/runbooks/pal-cutover.md')" || rc=$?
[[ $rc -le 1 ]] || { echo "brand-check: git grep failed (exit $rc)" >&2; exit "$rc"; }
if [[ -n "$domains" ]]; then
  printf '%s\n' "$domains" | sed 's/^/third-party domain: /' >&2
  [[ "$mode" != enforce ]] || { echo "brand-check: hosts on pal.run / pal.dev (third-party domains) found" >&2; exit 1; }
fi
