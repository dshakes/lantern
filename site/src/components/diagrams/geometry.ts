export type Pt = [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

export const center = (b: Rect): Pt => [b.x + b.w / 2, b.y + b.h / 2];

/** Where the ray from the box centre toward `p` leaves the box (p itself if inside). */
export function clip(b: Rect, p: Pt): Pt {
  const [cx, cy] = center(b);
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const tx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  return t >= 1 ? p : [cx + dx * t, cy + dy * t];
}

/** Polyline from box a to box b through `via`, trimmed to both borders (+ a gap at the arrow end). */
export function route(a: Rect, b: Rect, via: Pt[] = [], gap = 3): Pt[] {
  const pts: Pt[] = [center(a), ...via, center(b)];
  pts[0] = clip(a, pts[1]);
  const n = pts.length - 1;
  const end = clip(b, pts[n - 1]);
  const [px, py] = pts[n - 1];
  const len = Math.hypot(end[0] - px, end[1] - py) || 1;
  pts[n] = [end[0] - ((end[0] - px) / len) * gap, end[1] - ((end[1] - py) / len) * gap];
  return pts;
}

export const toPath = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

/** The point a fraction `f` of the way along a polyline. */
export function along(pts: Pt[], f: number): Pt {
  const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let rest = segs.reduce((s, l) => s + l, 0) * f;
  for (let i = 0; i < segs.length; i++) {
    if (rest <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(1, rest / segs[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    rest -= segs[i];
  }
  return pts[0];
}
