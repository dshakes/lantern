// Recording shows one of the README's terminal GIFs (docs/media, recorded with vhs from
// docs/media/tapes). predev/prebuild copy them into public/media (gitignored), so
// docs/media stays the single source. Served as a file rather than inlined like Diagram:
// a base64 GIF would ship twice per page (HTML + RSC payload).
export function Recording({ name, alt, caption }: { name: string; alt: string; caption?: string }) {
  const basePath = process.env.PAGES_BASE_PATH ?? "";
  return (
    <figure className="diagram">
      <img src={`${basePath}/media/${name}.gif`} alt={alt} width="100%" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
