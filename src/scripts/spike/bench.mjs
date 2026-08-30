/**
 * A benchmark helper that defaults to the right thing.
 *
 * Every timing mistake made on this module has been one of three, each costing a round trip and a
 * wrong conclusion:
 *
 *   - Single-shot measurement. A lone call includes JIT warm-up and first-touch allocation;
 *     `field.compute()` read 0.9 ms cold for work that does no Clipper ops at all.
 *   - Reporting the mean. One 295 ms GC spike inverted a ranking in the churn harness and produced
 *     a headline that was exactly backwards.
 *   - Comparing across warm states. Whichever variant ran first ate the warm-up for the rest,
 *     making the second look 1.9× faster on byte-identical input.
 *
 * So: warm up, report the median, never compare numbers from separate invocations.
 */

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: +sorted[0].toFixed(4),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(4),
    p95: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(4),
    max: +sorted[sorted.length - 1].toFixed(4),
    mean: +(sum / sorted.length).toFixed(4),
  };
};

/**
 * Time a function, warm.
 *
 * @param {Function} fn - Called with no arguments; its return value is ignored
 * @param {object} [options]
 * @param {number} [options.iterations=200]
 * @param {number} [options.warmup=50] - Untimed calls first
 * @param {string} [options.label]
 * @returns {object} Timing summary, also printed
 */
export function bench(fn, { iterations = 200, warmup = 50, label = fn.name || "anonymous" } = {}) {
  for (let i = 0; i < warmup; i++) fn();

  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }

  const result = stats(samples);
  console.error(
    `PF1 Lighting | ${label}: median ${result.median} ms ` +
      `(p95 ${result.p95}, max ${result.max}, mean ${result.mean}) ` +
      `over ${iterations} iterations +${warmup} warmup`
  );
  return result;
}

/**
 * Compare several implementations of the same thing.
 *
 * Round-robin rather than each to completion, so no variant absorbs the others' warm-up. That
 * ordering bias made a pre-filter look 5.7× better than it was, and leaves no trace in the output.
 *
 * @param {Record<string, Function>} cases
 * @param {object} [options] - As {@link bench}
 * @returns {Record<string, object>}
 */
export function compare(cases, { iterations = 200, warmup = 50 } = {}) {
  const names = Object.keys(cases);
  const samples = Object.fromEntries(names.map((n) => [n, []]));

  for (let i = 0; i < warmup; i++) {
    for (const name of names) cases[name]();
  }

  for (let i = 0; i < iterations; i++) {
    for (const name of names) {
      const t0 = performance.now();
      cases[name]();
      samples[name].push(performance.now() - t0);
    }
  }

  const results = Object.fromEntries(names.map((n) => [n, stats(samples[n])]));
  console.table(
    names.map((n) => ({
      case: n,
      "median ms": results[n].median,
      "p95 ms": results[n].p95,
      "max ms": results[n].max,
    }))
  );
  return results;
}
