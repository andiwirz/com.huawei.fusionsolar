'use strict';

// Thinning a capability history down to what a dashboard chart can draw (1.2.299).
//
// The sensor-chart widget used to receive every stored point — four series of a day at one
// point a minute is ~5 800 points, ~167 KB per poll — and then kept 250 of them by index,
// which drops whatever falls between the picks, peaks included. Thinning here, with
// Largest-Triangle-Three-Buckets, keeps the points that carry the shape of the curve and
// sends a few kilobytes.
//
// A history also has holes: a device that was unreachable contributes no points for that
// stretch, and the chart has to show a gap there rather than a line drawn straight across
// it. Points further apart than maxGapMs split the series; the pieces are thinned
// separately and joined with a { t, v: null } marker the widget breaks its line at.

/**
 * Largest-Triangle-Three-Buckets over one unbroken run of points.
 * @param {{t:number, v:number}[]} pts  sorted by t
 * @param {number} threshold            points to keep, ≥ 3
 */
function lttb(pts, threshold) {
  const n = pts.length;
  if (threshold >= n || threshold < 3) return pts.slice();
  const out = [pts[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // Average of the next bucket — the third corner of the triangle.
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd   = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgT = 0, avgV = 0;
    for (let j = nextStart; j < nextEnd; j++) { avgT += pts[j].t; avgV += pts[j].v; }
    const len = Math.max(1, nextEnd - nextStart);
    avgT /= len; avgV /= len;

    // The point of this bucket that spans the largest triangle with the last kept point.
    const start = Math.floor(i * every) + 1;
    const end   = Math.floor((i + 1) * every) + 1;
    let best = start, bestArea = -1;
    for (let j = start; j < end; j++) {
      const area = Math.abs((pts[a].t - avgT) * (pts[j].v - pts[a].v)
                          - (pts[a].t - pts[j].t) * (avgV - pts[a].v));
      if (area > bestArea) { bestArea = area; best = j; }
    }
    out.push(pts[best]);
    a = best;
  }
  out.push(pts[n - 1]);
  return out;
}

/**
 * @param {{t:number, v:number}[]} pts  sorted by t
 * @param {number} maxPoints            budget for the whole series
 * @param {number} maxGapMs             a larger distance between two points is a hole
 * @returns {{t:number, v:number|null}[]}
 */
function downsample(pts, maxPoints, maxGapMs) {
  if (!pts.length) return [];
  const runs = [[pts[0]]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t > maxGapMs) runs.push([]);
    runs[runs.length - 1].push(pts[i]);
  }
  const budget = Math.max(maxPoints - (runs.length - 1), runs.length * 3);
  const out = [];
  runs.forEach((run, k) => {
    if (k > 0) out.push({ t: run[0].t - 1, v: null });
    // floor, so the pieces plus their break markers stay within the budget
    const share = Math.max(3, Math.floor(budget * run.length / pts.length));
    for (const p of lttb(run, share)) out.push({ t: p.t, v: p.v });
  });
  return out;
}

module.exports = { lttb, downsample };
