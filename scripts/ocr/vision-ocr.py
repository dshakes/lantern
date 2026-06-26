#!/usr/bin/env python3
"""On-device OCR via the macOS Vision framework (no API key, no network,
no Xcode CLT — uses prebuilt pyobjc wheels). Usage: vision-ocr.py <image>
Prints recognized text to stdout. Fails quiet (empty output) on any error."""
import sys
try:
    import Vision, Quartz
    from Foundation import NSURL
except Exception:
    sys.exit(0)  # bindings missing -> empty, never crash the caller

def ocr(path: str) -> str:
    url = NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if not src or Quartz.CGImageSourceGetCount(src) == 0:
        return ""
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        return ""
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(1)         # 1 = accurate
    req.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    handler.performRequests_error_([req], None)
    out = []
    for obs in (req.results() or []):
        c = obs.topCandidates_(1)
        if c and len(c):
            out.append(c[0].string())
    return "\n".join(out)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(0)
    try:
        sys.stdout.write(ocr(sys.argv[1]) or "")
    except Exception:
        pass
