// Does the recommender actually work?
//
// Borrowed straight from validation practice: a system that produces a
// prediction and is never checked against outcome is not qualified, it
// is just running. FlixPix ranks every title, tells you why, and had
// never once been asked whether the titles it ranked highly were the
// ones you ended up liking.
//
// Everything here is computed from data already stored: `score_debug`
// written on every swipe since the original build, and verdicts from
// the watch lifecycle. No new capture required, which is the point --
// the measurement was always possible and simply never taken.

/**
 * Hit rate by score decile.
 *
 * The question this answers: of the titles the deck ranked most highly,
 * what fraction did you actually swipe right on? If the recommender is
 * working, the top decile should be dramatically higher than the
 * bottom. If the line is flat, the scoring is decorative.
 *
 * Uses swipes rather than verdicts because there are orders of
 * magnitude more of them; verdict-based accuracy is the better question
 * and gets its own function below, once there is enough data to ask it.
 */
export function scoreCalibration(swipes, buckets = 5) {
  const scored = (swipes || [])
    .filter((s) => (s.direction === 'left' || s.direction === 'right') && s.score_debug?.total != null)
    .map((s) => ({ total: Number(s.score_debug.total), right: s.direction === 'right' }))
    .filter((s) => Number.isFinite(s.total));

  // Below this, deciles are noise dressed as insight.
  if (scored.length < 40) return null;

  scored.sort((a, b) => a.total - b.total);
  const size = Math.floor(scored.length / buckets);
  if (size < 5) return null;

  const out = [];
  for (let i = 0; i < buckets; i++) {
    const from = i * size;
    const to = i === buckets - 1 ? scored.length : (i + 1) * size;
    const slice = scored.slice(from, to);
    const rights = slice.filter((s) => s.right).length;
    out.push({
      bucket: i,
      n: slice.length,
      rightRate: rights / slice.length,
      meanScore: slice.reduce((a, s) => a + s.total, 0) / slice.length,
    });
  }
  return out;
}

/**
 * A single number for "is the ranking doing anything".
 *
 * Top bucket right-rate minus bottom bucket right-rate. Positive means
 * the ordering carries signal; near zero means it does not. Reported as
 * a spread rather than a correlation because it is the version a person
 * can act on: "the deck's favourites get a yes 40 points more often
 * than its least favourites" is a sentence with meaning.
 */
export function calibrationSpread(calibration) {
  if (!calibration || calibration.length < 2) return null;
  return calibration[calibration.length - 1].rightRate - calibration[0].rightRate;
}

/**
 * The harder question: of things you actually WATCHED, did the ones the
 * deck rated highly turn out better?
 *
 * This is the real test, and it needs verdicts, which accumulate
 * slowly. Returns null rather than a shaky number until there are
 * enough, because a confident-looking accuracy figure built on six
 * ratings is worse than admitting you cannot tell yet.
 */
export function verdictCalibration(swipes, verdictRows, minRatings = 12) {
  const scoreByKey = new Map();
  for (const s of swipes || []) {
    if (s.score_debug?.total != null) {
      scoreByKey.set(`${s.tmdb_id}:${s.media_type}`, Number(s.score_debug.total));
    }
  }

  const rated = (verdictRows || [])
    .map((v) => ({
      score: scoreByKey.get(`${v.tmdb_id}:${v.media_type}`),
      up: v.verdict === 'up',
    }))
    .filter((r) => Number.isFinite(r.score));

  if (rated.length < minRatings) {
    return { enough: false, n: rated.length, need: minRatings };
  }

  rated.sort((a, b) => b.score - a.score);
  const half = Math.floor(rated.length / 2);
  const topHalf = rated.slice(0, half);
  const bottomHalf = rated.slice(half);

  const rate = (arr) => (arr.length ? arr.filter((r) => r.up).length / arr.length : 0);
  return {
    enough: true,
    n: rated.length,
    topRate: rate(topHalf),
    bottomRate: rate(bottomHalf),
    lift: rate(topHalf) - rate(bottomHalf),
  };
}

/**
 * Which scoring term is actually pulling weight.
 *
 * Mean value of each term among right-swipes minus among left-swipes.
 * A term near zero is contributing nothing and its weight could go to
 * something that is. This is the readout that makes the weights
 * tunable by evidence rather than by feel.
 */
export function termContribution(swipes) {
  const rights = [];
  const lefts = [];
  for (const s of swipes || []) {
    if (!s.score_debug) continue;
    if (s.direction === 'right') rights.push(s.score_debug);
    else if (s.direction === 'left') lefts.push(s.score_debug);
  }
  if (rights.length < 15 || lefts.length < 15) return null;

  const terms = ['partner', 'genre', 'keyword', 'verdict', 'quality', 'pop', 'recency'];
  const mean = (arr, t) => {
    const vals = arr.map((d) => Number(d[t])).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  return terms
    .map((t) => {
      const r = mean(rights, t);
      const l = mean(lefts, t);
      if (r === null || l === null) return null;
      return { term: t, separation: r - l };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.separation) - Math.abs(a.separation));
}

/**
 * How well do you predict each other?
 *
 * The prediction game's actual output. Reported with the sample size
 * because "you are 70% right" from ten guesses is not a fact.
 */
export function predictionAccuracy(predictions) {
  const resolved = (predictions || []).filter((p) => p.resolved_at && p.was_correct !== null);
  if (resolved.length === 0) return null;
  const correct = resolved.filter((p) => p.was_correct).length;
  return {
    n: resolved.length,
    correct,
    rate: correct / resolved.length,
    // Below this, do not draw conclusions out loud.
    confident: resolved.length >= 15,
  };
}
