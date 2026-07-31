import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessTally, recentResults, SAID } from './guess-score.js';

const P = (o) => ({
  id: o.id, tmdb_id: o.tmdb ?? 1, media_type: 'movie',
  guess: o.guess, resolved_at: o.at ?? null, was_correct: o.correct ?? null,
});

test('score is correct minus wrong, matching the +1 and -1 shown', () => {
  const t = guessTally([
    P({ id: 'a', guess: 'right', at: 'x', correct: true }),
    P({ id: 'b', guess: 'left', at: 'x', correct: true }),
    P({ id: 'c', guess: 'right', at: 'x', correct: false }),
  ]);
  assert.equal(t.correct, 2);
  assert.equal(t.wrong, 1);
  assert.equal(t.score, 1);
  assert.equal(t.total, 3);
});

test('unresolved guesses count as pending, never as wrong', () => {
  const t = guessTally([
    P({ id: 'a', guess: 'right', at: 'x', correct: true }),
    P({ id: 'b', guess: 'right' }),
    P({ id: 'c', guess: 'left' }),
  ]);
  assert.equal(t.total, 1, 'only resolved guesses are scored');
  assert.equal(t.pending, 2);
  assert.equal(t.wrong, 0);
});

test('a thin record refuses to call itself confident', () => {
  const few = guessTally([P({ id: 'a', guess: 'right', at: 'x', correct: true })]);
  assert.equal(few.confident, false);
  const many = Array.from({ length: 12 }, (_, i) =>
    P({ id: `g${i}`, guess: 'right', at: 'x', correct: i % 3 !== 0 })
  );
  assert.equal(guessTally(many).confident, true);
});

test('no guesses at all is zeros, not a crash or a fake rate', () => {
  const t = guessTally([]);
  assert.equal(t.total, 0);
  assert.equal(t.rate, null, 'a rate from no data would be a lie');
});

test('a wrong guess reports what they actually said', () => {
  const titles = new Map([['5:movie', { title: 'Toradora!' }]]);
  const out = recentResults(
    [P({ id: 'a', tmdb: 5, guess: 'right', at: '2026-07-25', correct: false })],
    titles
  );
  assert.equal(out[0].title, 'Toradora!');
  assert.equal(out[0].guess, 'right');
  assert.equal(out[0].actual, 'left', 'wrong guess means they did the opposite');
  assert.equal(SAID[out[0].actual], 'Pass');
});

test('a correct guess reports their answer as the guess', () => {
  const titles = new Map([['5:movie', { title: 'Toradora!' }]]);
  const out = recentResults(
    [P({ id: 'a', tmdb: 5, guess: 'left', at: '2026-07-25', correct: true })],
    titles
  );
  assert.equal(out[0].actual, 'left');
  assert.equal(out[0].correct, true);
});

test('a title dropped from the pool degrades to a label, not a blank', () => {
  const out = recentResults(
    [P({ id: 'a', tmdb: 999, guess: 'right', at: 'x', correct: true })],
    new Map()
  );
  assert.match(out[0].title, /no longer/);
});

test('results are newest first', () => {
  const out = recentResults([
    P({ id: 'old', guess: 'right', at: '2026-01-01', correct: true }),
    P({ id: 'new', guess: 'right', at: '2026-07-01', correct: true }),
  ], new Map());
  assert.equal(out[0].id, 'new');
});
