// /runtime used to be its own page; the runtime story now lives on the home page.
// A static export has no server redirects, so this is a meta-refresh stub.
const target = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/#measured`;

export const metadata = { title: "Lantern runtime", robots: { index: false } };

export default function RuntimeRedirect() {
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <p className="p-8">
        Moved to <a href={target}>the home page</a>.
      </p>
    </>
  );
}
