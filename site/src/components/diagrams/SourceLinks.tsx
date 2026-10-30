import { srcHref, srcLabel, type Src } from "./types";

export function SourceLinks({ src }: { src?: Src[] }) {
  if (!src?.length) return null;
  return (
    <span className="ix-src">
      {src.map((s) => (
        <a key={`${s.ref ?? ""}${s.p}:${s.l ?? ""}`} href={srcHref(s)} target="_blank" rel="noreferrer">
          {srcLabel(s)}
          {s.ref === "broker" ? " (broker mode)" : ""}
        </a>
      ))}
    </span>
  );
}
