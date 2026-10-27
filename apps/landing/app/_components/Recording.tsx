"use client";

import { Play } from "lucide-react";
import { useState } from "react";

// Shows a terminal recording's last frame (the result) until someone asks to
// watch it play; the GIF only downloads then.
export function Recording({ gif, poster, alt }: { gif: string; poster: string; alt: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element -- static export; a GIF is the recording */}
      <img src={playing ? gif : poster} alt={alt} width={1240} height={760} decoding="async" loading="lazy" className="block h-auto w-full" />
      {!playing && (
        <button type="button" onClick={() => setPlaying(true)} className="console-btn absolute bottom-3 right-3 inline-flex items-center gap-1.5 bg-[var(--dm-bg)] !px-3 !py-1.5">
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> Replay the recording
        </button>
      )}
    </div>
  );
}
