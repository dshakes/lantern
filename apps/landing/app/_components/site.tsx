import Link from "next/link";
import { LanternMark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const GITHUB = "https://github.com/dshakes/lantern";
export const BLOB = `${GITHUB}/blob/master`;
// On Pages the docs are served next to this page, under /docs.
export const DOCS = process.env.NEXT_PUBLIC_DOCS_URL ?? `${BASE}/docs/`;
export const QUICKSTART = `${GITHUB}#quickstart`;
export const wrap = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-10";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/85 backdrop-blur-md">
      <div className={`${wrap} flex h-16 items-center justify-between gap-4`}>
        <Link href="/" className="flex items-center gap-2 font-semibold" aria-label="Lantern home">
          <LanternMark className="h-7 w-7" />
          <span className="text-lg tracking-tight">Lantern</span>
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-1 text-sm text-ink-2 md:flex">
          <Link href="/#how" className="rounded-md px-3 py-1.5 hover:text-ink">
            How it works
          </Link>
          <Link href="/compare/" className="rounded-md px-3 py-1.5 hover:text-ink">
            Compare
          </Link>
          <a href={DOCS} className="rounded-md px-3 py-1.5 hover:text-ink">
            Docs
          </a>
        </nav>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <a href={GITHUB} className="btn btn-quiet !px-3 !py-1.5 text-sm">
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line py-10">
      <div className={`${wrap} flex flex-wrap items-center justify-between gap-4 text-sm text-ink-3`}>
        <span className="flex items-center gap-2">
          <LanternMark className="h-5 w-5" /> Lantern is open source under Apache-2.0.
        </span>
        <nav aria-label="Footer" className="flex flex-wrap gap-5">
          <a href={DOCS} className="hover:text-ink">
            Docs
          </a>
          <Link href="/compare/" className="hover:text-ink">
            Compare
          </Link>
          <a href={GITHUB} className="hover:text-ink">
            GitHub
          </a>
          <Link href="/privacy/" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/terms/" className="hover:text-ink">
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}

// The two primary actions, used in the hero and the closing CTA.
export function Actions({ center = false }: { center?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-3 ${center ? "justify-center" : ""}`}>
      <a href={QUICKSTART} className="btn btn-primary">
        Run it locally
      </a>
      <a href={GITHUB} className="btn btn-quiet">
        Star on GitHub
      </a>
      <span className="w-full text-sm text-ink-3 sm:w-auto sm:pl-2">Needs Docker. Apache-2.0.</span>
    </div>
  );
}
