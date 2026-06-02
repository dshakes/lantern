// Decode chat.db `attributedBody` blobs into plain message text.
//
// Newer macOS (and RCS/SMS) leave `message.text` NULL and store the body in
// `attributedBody` — an `NSAttributedString` serialized as a typedstream
// ("streamtyped") archive. We don't fully parse the archive; we extract its
// backing NSString, which holds the visible text. Layout after the class name:
//
//   ... "NSString" <class refs> 0x2B <len> <utf8 bytes> ...
//
// where <len> is a 1-byte length when < 0x80, or 0x81 + u16-LE, or 0x82 +
// u32-LE for longer strings. Pure + dependency-free so it's unit-testable
// without the native sqlite binding.

/**
 * Extract the plain text from an `attributedBody` blob. Returns null on
 * anything unexpected, so a decode miss is indistinguishable from "no text"
 * (no regression vs. the old text-only read; never throws).
 */
export function decodeAttributedBody(
  buf: Buffer | Uint8Array | null | undefined,
): string | null {
  if (!buf || buf.length === 0) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  const marker = b.indexOf("NSString", 0, "latin1");
  if (marker === -1) return null;
  // The '+' (0x2B) byte marks the start of the length-prefixed string body.
  let i = b.indexOf(0x2b, marker);
  if (i === -1) return null;
  i += 1;
  if (i >= b.length) return null;

  let len = b[i];
  i += 1;
  if (len === 0x81) {
    if (i + 2 > b.length) return null;
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > b.length) return null;
    len = b.readUInt32LE(i);
    i += 4;
  } else if (len >= 0x80) {
    return null; // unexpected length encoding
  }
  if (len <= 0 || i + len > b.length) return null;

  const text = b
    .toString("utf8", i, i + len)
    .replace(/ +$/g, "")
    .trim();
  return text || null;
}
