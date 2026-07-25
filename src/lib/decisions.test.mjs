import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tonightPlan, upcomingPlans, overduePlans } from './plans-pure.js';
import { eloRatings, pickAffinity, rankedTitles } from './picks-pure.js';
import {
  scoreCalibration, calibrationSpread, verdictCalibration,
  termContribution, predictionAccuracy,
} from './calibration.js';

const P = (o) => ({ id: o.id, planned_for: o.on ?? null, created_at: o.at ?? '2026-07-01', status: 'planned' });
const pick = (w, l, at = '2026-07-01') => ({
  winner_tmdb_id: w, winner_media_type: 'movie',
  loser_tmdb_id: l, loser_media_type: 'movie', decided_at: at,
});
const sw = (dir, total, id = 1) => ({
  tmdb_id: id, media_type: 'movie', direction: dir, score_debug: { total },
});

// ---------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------

test("today's dated plan beats an undated one", () => {
  const today = new Date('2026-07-25T20:00:00Z');
  const plans = [P({ id: 'a', at: '2026-07-20' }), P({ id: 'b', on: '2026-07-25' })];
  assert.equal(tonightPlan(plans, today).id, 'b');
});

test('an overdue plan is not promoted to tonight', () => {
  // A date you missed is a thing to reschedule, not a thing to be
  // nagged about every evening afterwards.
  const today = new Date('2026-07-25T20:00:00Z');
  const plans = [P({ id: 'old', on: '2026-07-01' })];
  assert.equal(tonightPlan(plans, today), null);
  assert.deepEqual(overduePlans(plans, today).map((p) => p.id), ['old']);
});

test('a future plan is upcoming, not tonight', () => {
  const today = new Date('2026-07-25T20:00:00Z');
  const plans = [P({ id: 'later', on: '2026-08-14' })];
  assert.equal(tonightPlan(plans, today), null);
  assert.deepEqual(upcomingPlans(plans, today).map((p) => p.id), ['later']);
});

test('no plans at all is null, not a crash', () => {
  assert.equal(tonightPlan([], new Date()), null);
  assert.equal(tonightPlan(null, new Date()), null);
});

// ---------------------------------------------------------------------
// Pairwise picks
// ---------------------------------------------------------------------

test('winning raises your rating and losing lowers it', () => {
  const r = eloRatings([pick(1, 2)]);
  assert.ok(r.get('1:movie') > 1500);
  assert.ok(r.get('2:movie') < 1500);
});

test('beating a strong title is worth more than beating a weak one', () => {
  // This is why Elo rather than counting wins: a raw tally cannot
  // express that some wins mean more.
  const strongFirst = eloRatings([
    pick(2, 3, '2026-07-01'), pick(2, 4, '2026-07-02'), pick(2, 5, '2026-07-03'),
    pick(1, 2, '2026-07-04'),
  ]);
  const weakOnly = eloRatings([
    pick(3, 2, '2026-07-01'), pick(4, 2, '2026-07-02'), pick(5, 2, '2026-07-03'),
    pick(1, 2, '2026-07-04'),
  ]);
  assert.ok(strongFirst.get('1:movie') > weakOnly.get('1:movie'),
    'beating a title with a good record should be worth more');
});

test('ratings are applied oldest first', () => {
  const a = eloRatings([pick(1, 2, '2026-07-02'), pick(2, 3, '2026-07-01')]);
  const b = eloRatings([pick(2, 3, '2026-07-01'), pick(1, 2, '2026-07-02')]);
  assert.equal(a.get('1:movie'), b.get('1:movie'),
    'input order must not change the result; only decided_at should');
});

test('an unrated title contributes exactly nothing to scoring', () => {
  const r = eloRatings([pick(1, 2)]);
  assert.equal(pickAffinity('99:movie', r), 0);
  assert.ok(pickAffinity('1:movie', r) > 0);
});

test('affinity is clamped so a hot streak cannot swamp the model', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push(pick(1, 100 + i, `2026-07-${(i % 28) + 1}`));
  const r = eloRatings(many);
  assert.ok(pickAffinity('1:movie', r) <= 1);
});

test('ranking needs more than a single comparison', () => {
  const ranked = rankedTitles([pick(1, 2)], 2);
  assert.equal(ranked.length, 0, 'one head-to-head is not a ranking');
  const ranked2 = rankedTitles([pick(1, 2), pick(1, 3)], 2);
  assert.ok(ranked2.some((x) => x.key === '1:movie'));
});

// ---------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------

test('calibration stays silent on thin data instead of inventing deciles', () => {
  const few = Array.from({ length: 20 }, (_, i) => sw(i % 2 ? 'right' : 'left', i));
  assert.equal(scoreCalibration(few), null);
});

test('a working recommender shows a positive spread', () => {
  // High scores mostly right, low scores mostly left.
  const swipes = [];
  for (let i = 0; i < 60; i++) swipes.push(sw('right', 5 + Math.random(), i));
  for (let i = 0; i < 60; i++) swipes.push(sw('left', 0 + Math.random(), 1000 + i));
  const cal = scoreCalibration(swipes);
  assert.ok(cal && cal.length === 5);
  const spread = calibrationSpread(cal);
  assert.ok(spread > 0.5, `expected a clear spread, got ${spread}`);
});

test('a useless recommender shows a spread near zero', () => {
  // This is the case that matters: the readout has to be able to tell
  // Kevin the scoring is decorative, or it is not a measurement.
  const swipes = [];
  for (let i = 0; i < 120; i++) swipes.push(sw(i % 2 ? 'right' : 'left', Math.random() * 5, i));
  const spread = calibrationSpread(scoreCalibration(swipes));
  assert.ok(Math.abs(spread) < 0.35, `expected near zero, got ${spread}`);
});

test('verdict calibration refuses to answer until there are enough ratings', () => {
  const swipes = [sw('right', 5, 1), sw('right', 1, 2)];
  const verdicts = [
    { tmdb_id: 1, media_type: 'movie', verdict: 'up' },
    { tmdb_id: 2, media_type: 'movie', verdict: 'down' },
  ];
  const out = verdictCalibration(swipes, verdicts);
  assert.equal(out.enough, false);
  assert.equal(out.n, 2);
  assert.ok(out.need > 2, 'it says how many more it needs');
});

test('verdict calibration reports lift once there is enough', () => {
  const swipes = [];
  const verdicts = [];
  for (let i = 0; i < 10; i++) {
    swipes.push(sw('right', 9 - i * 0.1, i));
    verdicts.push({ tmdb_id: i, media_type: 'movie', verdict: 'up' });
  }
  for (let i = 100; i < 110; i++) {
    swipes.push(sw('right', 0.5, i));
    verdicts.push({ tmdb_id: i, media_type: 'movie', verdict: 'down' });
  }
  const out = verdictCalibration(swipes, verdicts);
  assert.equal(out.enough, true);
  assert.ok(out.lift > 0.5, `high-scored titles should be liked more, lift was ${out.lift}`);
});

test('term contribution ranks terms by how much they separate yes from no', () => {
  const swipes = [];
  for (let i = 0; i < 20; i++) {
    swipes.push({ direction: 'right', score_debug: { total: 5, genre: 0.9, pop: 0.5, quality: 0.5 } });
    swipes.push({ direction: 'left', score_debug: { total: 1, genre: 0.1, pop: 0.5, quality: 0.5 } });
  }
  const out = termContribution(swipes);
  assert.equal(out[0].term, 'genre', 'the term that actually separates should rank first');
  const pop = out.find((t) => t.term === 'pop');
  assert.ok(Math.abs(pop.separation) < 0.01, 'a term with no separation is reported as carrying nothing');
});

test('prediction accuracy reports its own sample size and confidence', () => {
  const few = [{ resolved_at: 'x', was_correct: true }, { resolved_at: 'x', was_correct: false }];
  const a = predictionAccuracy(few);
  assert.equal(a.n, 2);
  assert.equal(a.confident, false, 'two guesses is not a finding');

  const many = Array.from({ length: 20 }, (_, i) => ({ resolved_at: 'x', was_correct: i % 4 !== 0 }));
  const b = predictionAccuracy(many);
  assert.equal(b.confident, true);
  assert.ok(b.rate > 0.7);
});

test('unresolved predictions are not counted as wrong', () => {
  const mixed = [
    { resolved_at: 'x', was_correct: true },
    { resolved_at: null, was_correct: null },
  ];
  assert.equal(predictionAccuracy(mixed).n, 1);
});
