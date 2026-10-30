import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import "./interactive.css";
import { VIEWS, type ArchEdge, type ArchNode, type ArchView, type Layer } from "./architecture-data";
import { along, route, toPath } from "./geometry";
import { SourceLinks } from "./SourceLinks";
import { docsHref } from "./types";

type ViewId = ArchView["id"];
type Mode = "guest" | "broker";

const visibleLayer = (layer: Layer | undefined, stores: boolean, mode: Mode) =>
  !layer || (layer === "store" ? stores : layer === mode);

export function ArchitectureExplorer({ initialView = "system" }: { initialView?: ViewId }) {
  const uid = useId().replace(/:/g, "");
  const canvas = useRef<HTMLDivElement>(null);
  const [viewId, setViewId] = useState<ViewId>(initialView);
  const [sel, setSel] = useState<string | null>(null);
  const [trust, setTrust] = useState(false);
  const [stores, setStores] = useState(false);
  const [planes, setPlanes] = useState(true);
  const [mode, setMode] = useState<Mode>("guest");

  const view = VIEWS[viewId];
  const { nodes, edges, byId } = useMemo(() => {
    const nodes = view.nodes.filter((n) => visibleLayer(n.layer, stores, mode));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = view.edges.filter((e) => visibleLayer(e.layer, stores, mode) && byId.has(e.from) && byId.has(e.to));
    return { nodes, edges, byId };
  }, [view, stores, mode]);

  const selNode = sel ? byId.get(sel) ?? null : null;
  const touching = (e: ArchEdge) => !!selNode && (e.from === selNode.id || e.to === selNode.id);
  const near = new Set(selNode ? edges.filter(touching).flatMap((e) => [e.from, e.to]) : []);

  const open = (id: ViewId) => {
    setViewId(id);
    setSel(null);
  };
  const select = (id: string, reveal = false) => {
    setSel(id);
    const n = byId.get(id);
    const c = canvas.current;
    if (reveal && n && c && c.scrollWidth > c.clientWidth) {
      const scale = c.scrollWidth / view.vb[0];
      c.scrollTo({ left: (n.box.x + n.box.w / 2) * scale - c.clientWidth / 2, behavior: "smooth" });
    }
  };
  const onNodeKey = (e: KeyboardEvent, n: ArchNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (sel === n.id && n.zoom && n.zoom !== viewId) open(n.zoom);
      else select(n.id);
    }
  };

  return (
    <div className="ix not-content my-8" onKeyDown={(e) => e.key === "Escape" && setSel(null)}>
      <div className="ix-bar mb-3" role="group" aria-label="Diagram view">
        {(Object.keys(VIEWS) as ViewId[]).map((id) => (
          <button key={id} type="button" className="ix-btn" aria-pressed={viewId === id} onClick={() => open(id)}>
            {VIEWS[id].title}
          </button>
        ))}
        <span className="ix-sep" aria-hidden="true" />
        <button type="button" className="ix-btn" aria-pressed={trust} onClick={() => setTrust(!trust)}>
          <span className="ix-sw" style={{ border: "1.5px dashed var(--lx-signal)" }} aria-hidden="true" />
          Trust boundaries
        </button>
        {viewId === "system" && (
          <>
            <button type="button" className="ix-btn" aria-pressed={stores} onClick={() => setStores(!stores)}>
              <span className="ix-sw" style={{ background: "var(--lx-surface-2)", border: "1px solid var(--lx-line)" }} aria-hidden="true" />
              Data stores
            </button>
            <button type="button" className="ix-btn" aria-pressed={planes} onClick={() => setPlanes(!planes)}>
              <span className="ix-sw" style={{ border: "1.5px dashed var(--lx-ink-3)" }} aria-hidden="true" />
              Control / data plane
            </button>
          </>
        )}
        <span className="ix-sep" aria-hidden="true" />
        <span role="radiogroup" aria-label="Egress mode" className="ix-bar">
          <button type="button" role="radio" className="ix-btn" aria-checked={mode === "guest"} aria-pressed={mode === "guest"} onClick={() => setMode("guest")}>
            Guest egress (default)
          </button>
          <button type="button" role="radio" className="ix-btn" aria-checked={mode === "broker"} aria-pressed={mode === "broker"} onClick={() => setMode("broker")}>
            <span className="ix-sw" style={{ background: "var(--lx-flame)" }} aria-hidden="true" />
            Broker mode (opt-in)
          </button>
        </span>
      </div>

      <div className="ix-stage">
          <div className="ix-canvas" ref={canvas}>
            <svg
              viewBox={`0 0 ${view.vb[0]} ${view.vb[1]}`}
              style={{ minWidth: 900 }}
              role="group"
              aria-label={`${view.title} architecture. ${view.lede}`}
            >
              <defs>
                <marker id={`${uid}-a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" className="ix-arrow" />
                </marker>
              </defs>

              {view.frames
                .filter((f) => visibleLayer(f.layer, stores, mode) && (planes || (f.kind !== "cp" && f.kind !== "dp")))
                .map((f) => (
                  <g key={f.label} aria-hidden="true">
                    <rect className={`fr-${f.kind}`} x={f.box.x} y={f.box.y} width={f.box.w} height={f.box.h} rx={f.kind === "wall" ? 20 : 16} />
                    <text className={`fr-label${f.kind === "wall" ? " wall" : ""}`} x={f.box.x + 14} y={f.kind === "wall" ? f.box.y + f.box.h - 10 : f.box.y + 18}>
                      {f.label}
                    </text>
                  </g>
                ))}

              {edges.map((e) => {
                const pts = route(byId.get(e.from)!.box, byId.get(e.to)!.box, e.via);
                const [lx, ly] = along(pts, e.at ?? 0.5);
                const on = touching(e);
                return (
                  <g
                    key={`${e.from}-${e.to}-${e.label}`}
                    className={`ix-edge${e.layer ? ` l-${e.layer}` : ""}${on ? " on" : ""}${selNode && !on ? " ix-dim" : ""}`}
                    aria-hidden="true"
                  >
                    <path d={toPath(pts)} markerEnd={`url(#${uid}-a)`} markerStart={e.bidi ? `url(#${uid}-a)` : undefined} />
                    {e.label && (
                      <text x={lx} y={ly - 5} textAnchor="middle">
                        {e.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {nodes.map((n) => {
                const { x, y, w, h } = n.box;
                const dim = selNode && n.id !== selNode.id && !near.has(n.id);
                return (
                  <g
                    key={n.id}
                    className={`ix-node tone-${n.tone}${dim ? " ix-dim" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel === n.id}
                    aria-label={`${n.title}: ${n.sub}${n.zoom && n.zoom !== viewId ? ". Press Enter again to open its component view" : ""}`}
                    onClick={() => select(n.id)}
                    onDoubleClick={() => n.zoom && n.zoom !== viewId && open(n.zoom)}
                    onKeyDown={(e) => onNodeKey(e, n)}
                  >
                    <rect className="ring" x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={13} />
                    <rect className="box" x={x} y={y} width={w} height={h} rx={10} />
                    <text className="t1" x={x + 12} y={y + h / 2 - 3}>
                      {n.title}
                    </text>
                    <text className="t2" x={x + 12} y={y + h / 2 + 15}>
                      {n.sub}
                    </text>
                    {n.zoom && n.zoom !== viewId && (
                      <text className="ix-zoomtag" x={x + w - 10} y={y + 16} textAnchor="end">
                        view ›
                      </text>
                    )}
                    {trust && n.gate && (
                      <g className="ix-gate">
                        <rect x={x - 6} y={y - 6} width={w + 12} height={h + 12} rx={14} />
                        <text x={x + w + 2} y={y - 10} textAnchor="end">
                          {n.gate}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        {/* Details float over the half of the map away from the selected node; below it on narrow screens. */}
        <aside
          className={`ix-panel ix-drawer${selNode && selNode.box.x + selNode.box.w / 2 > view.vb[0] / 2 ? " left" : ""}`}
          aria-live="polite"
          hidden={!selNode}
        >
          {selNode && (
            <>
              <button type="button" className="ix-close" aria-label="Close details" onClick={() => setSel(null)}>
                ×
              </button>
              <NodePanel node={selNode} view={view} edges={edges} byId={byId} onSelect={(id) => select(id, true)} onOpen={open} />
            </>
          )}
        </aside>
      </div>
      <p className="ix-pan-hint">Swipe sideways to pan the diagram. Tap a component for details.</p>
      <Intro view={view} mode={mode} />
    </div>
  );
}

function Intro({ view, mode }: { view: ArchView; mode: Mode }) {
  return (
    <div className="mt-3 text-sm text-ink-2">
      <p>{view.lede}</p>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        {[
          ["var(--lx-patina-soft)", "var(--lx-patina)", "Trusted host code"],
          ["var(--lx-flame-soft)", "var(--lx-flame)", "Untrusted guest code"],
          ["transparent", "var(--lx-glass)", "The microVM wall"],
          ["transparent", "var(--lx-signal)", "A gate: what a caller must present"],
        ].map(([bg, bd, label]) => (
          <li key={label} className="flex items-center gap-2 text-ink-2">
            <span className="ix-sw" style={{ background: bg, border: `2px solid ${bd}` }} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
      {mode === "broker" && (
        <p className="mt-3">
          <span className="ix-badge">Broker mode is opt-in</span> <code>PAL_EGRESS_MODE=broker</code> on the runtime-manager,
          Firecracker only. The VM has no network device; egress crosses vsock to the host.
        </p>
      )}
    </div>
  );
}

function NodePanel({
  node, view, edges, byId, onSelect, onOpen,
}: {
  node: ArchNode;
  view: ArchView;
  edges: ArchEdge[];
  byId: Map<string, ArchNode>;
  onSelect: (id: string) => void;
  onOpen: (id: ViewId) => void;
}) {
  const links = edges.filter((e) => e.from === node.id || e.to === node.id);
  return (
    <div>
      <h3>{node.title}</h3>
      <dl className="ix-meta">
        {node.lang && (
          <>
            <dt>Language</dt>
            <dd>{node.lang}</dd>
          </>
        )}
        {node.ports && (
          <>
            <dt>Ports</dt>
            <dd>{node.ports}</dd>
          </>
        )}
      </dl>
      {node.layer === "broker" && (
        <p className="mt-3">
          <span className="ix-badge">Opt-in · broker mode · Firecracker only</span>
        </p>
      )}
      <h4>What it does</h4>
      <p>{node.role}</p>
      {node.boundary && (
        <>
          <h4>Trust boundary</h4>
          <p>{node.boundary}</p>
        </>
      )}
      {node.invariants.length > 0 && (
        <>
          <h4>Guarantees</h4>
          <ul>
            {node.invariants.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </>
      )}
      {links.length > 0 && (
        <>
          <h4>Talks to</h4>
          <ul>
            {links.map((e) => {
              const other = byId.get(e.from === node.id ? e.to : e.from)!;
              const dir = e.bidi ? "⇄" : e.from === node.id ? "→" : "←";
              return (
                <li key={`${e.from}-${e.to}-${e.label}`}>
                  {dir}{" "}
                  <button type="button" className="ix-link" onClick={() => onSelect(other.id)}>
                    {other.title}
                  </button>
                  {e.label && <span className="text-ink-3"> · {e.label}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <h4>Source</h4>
      <SourceLinks src={node.src} />
      <div className="mt-4 flex flex-wrap gap-2">
        {node.zoom && node.zoom !== view.id && (
          <button type="button" className="ix-btn" onClick={() => onOpen(node.zoom!)}>
            Open {VIEWS[node.zoom].title.toLowerCase()} view
          </button>
        )}
        {node.docs && (
          <a href={docsHref(node.docs.href)} className="ix-btn">
            {node.docs.label} docs
          </a>
        )}
      </div>
    </div>
  );
}
