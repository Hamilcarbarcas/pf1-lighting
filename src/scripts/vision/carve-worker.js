// Cuts an observer's view off the main thread (DESIGN.md §9.14). A classic worker, because Clipper is
// a classic script that assigns ClipperLib to self.

importScripts("../../../../../scripts/clipper/clipper.js");

const { Clipper, ClipType, Paths, PolyFillType, PolyType } = ClipperLib;

// Rings sent once and kept, already scaled. Most come back unchanged step to step.
const rings = new Map();

let scale = 1;

function toPath(flat, factor) {
  const path = new Array(flat.length / 2);
  for (let i = 0; i < path.length; i++) {
    path[i] = { X: Math.round(flat[i * 2] * factor), Y: Math.round(flat[(i * 2) + 1] * factor) };
  }
  return path;
}

// As geometry.mjs' fromClipperPaths: a path under three points isn't a polygon.
function fromPaths(paths, buffers) {
  const out = [];
  for (const path of paths) {
    if (path.length < 3) continue;
    const flat = new Float64Array(path.length * 2);
    for (let i = 0; i < path.length; i++) {
      flat[i * 2] = path[i].X / scale;
      flat[(i * 2) + 1] = path[i].Y / scale;
    }
    buffers.push(flat.buffer);
    out.push(flat);
  }
  return out;
}

// As geometry.mjs' difference and intersection: non-zero fill on both sides.
function op(clipType, subject, clip) {
  const c = new Clipper();
  c.AddPaths(subject, PolyType.ptSubject, true);
  c.AddPaths(clip, PolyType.ptClip, true);
  const solution = new Paths();
  c.Execute(clipType, solution, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return solution;
}

// As umbra-mask.mjs' split.
function cut({ polygon, removed, keep }, buffers) {
  if (!polygon || (!removed.length && !keep.length)) return { live: null, preview: [] };
  const cutBy = removed.map((id) => rings.get(id));
  let paths = [toPath(polygon, scale)];
  if (cutBy.length) paths = op(ClipType.ctDifference, paths, cutBy);
  if (!keep.length) return { live: fromPaths(paths, buffers), preview: [] };
  const kept = keep.map((id) => rings.get(id));
  return {
    live: fromPaths(op(ClipType.ctDifference, paths, kept), buffers),
    preview: fromPaths(op(ClipType.ctIntersection, paths, kept), buffers),
  };
}

self.onmessage = ({ data }) => {
  if (data.type === "clear") {
    rings.clear();
    return;
  }
  const t0 = performance.now();
  try {
    scale = data.scale;
    let at = 0;
    data.defIds.forEach((id, i) => {
      rings.set(id, toPath(data.data.subarray(at, at + data.sizes[i]), 1));
      at += data.sizes[i];
    });
    const buffers = [];
    const light = cut(data.light, buffers);
    const sight = cut(data.sight, buffers);
    self.postMessage({ id: data.id, light, sight, ms: performance.now() - t0 }, buffers);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message ?? error) });
  }
};
