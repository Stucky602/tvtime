import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, serviceAdvice } from './stats.js';

const T = (id, genres, providers) => ({
  tmdb_id: id, media_type: 'movie', title: `T${id}`, genres, providers,
});
const sw = (user, id, dir) => ({ user_id: user, tmdb_id: id, media_type: 'movie', direction: dir });

function fixture() {
  const titles = [T(1,[1],['netflix']), T(2,[1],['netflix']), T(3,[2],['paramount']), T(4,[3],['netflix','max'])];
  const titlesByKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const swipes = [
    sw('me',1,'right'), sw('you',1,'right'),   // match
    sw('me',2,'right'), sw('you',2,'left'),    // split
    sw('me',3,'left'),  sw('you',3,'left'),    // both passed
    sw('me',4,'right'), sw('you',4,'right'),   // match
    sw('me',9,'right'),                         // one-sided, must not count
  ];
  return { swipes, titlesByKey };
}

test('agreement counts both-passed as agreeing, and ignores one-sided votes', () => {
  const { swipes, titlesByKey } = fixture();
  const s = computeStats({ swipes, userId: 'me', partnerId: 'you', titlesByKey });
  assert.equal(s.decided, 4, 'the one-sided swipe is excluded');
  assert.equal(s.matches, 2);
  assert.equal(s.splits, 1);
  assert.equal(s.bothPassed, 1);
  // 3 of 4 agreed (2 matches + 1 mutual pass)
  assert.equal(s.agreementPct, 75);
});

test('per-service match counts credit every service a title is on', () => {
  const { swipes, titlesByKey } = fixture();
  const s = computeStats({ swipes, userId: 'me', partnerId: 'you', titlesByKey });
  const byslug = Object.fromEntries(s.services.map((x) => [x.slug, x.count]));
  assert.equal(byslug.netflix, 2, 'titles 1 and 4');
  assert.equal(byslug.max, 1, 'title 4 counts for max too');
  assert.equal(byslug.paramount, undefined, 'no matches on paramount');
});

test('shared vs split genres are separated', () => {
  const { swipes, titlesByKey } = fixture();
  const s = computeStats({ swipes, userId: 'me', partnerId: 'you', titlesByKey });
  assert.ok(s.sharedGenres.some((g) => g.id === 1), 'genre 1 matched');
  assert.ok(s.splitGenres.some((g) => g.id === 1), 'genre 1 also split once');
});

test('no partner yet: agreement is null rather than a misleading zero', () => {
  const { swipes, titlesByKey } = fixture();
  const s = computeStats({ swipes, userId: 'me', partnerId: null, titlesByKey });
  assert.equal(s.decided, 0);
  assert.equal(s.agreementPct, null);
});

test('service advice stays silent until there is real evidence', () => {
  const { swipes, titlesByKey } = fixture();
  const s = computeStats({ swipes, userId: 'me', partnerId: 'you', titlesByKey });
  assert.equal(
    serviceAdvice(s, ['netflix', 'paramount']),
    null,
    'two matches is nowhere near enough to advise cancelling anything'
  );
});

test('service advice flags a dead service once evidence exists', () => {
  const titles = [];
  const swipes = [];
  for (let i = 1; i <= 40; i++) {
    titles.push(T(i, [1], ['netflix']));
    swipes.push(sw('me', i, 'right'), sw('you', i, 'right'));
  }
  const titlesByKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const s = computeStats({ swipes, userId: 'me', partnerId: 'you', titlesByKey });
  const advice = serviceAdvice(s, ['netflix', 'paramount']);
  assert.ok(advice, 'should speak up after 40 matches');
  assert.equal(advice[0].slug, 'paramount');
  assert.equal(advice[0].count, 0);
  assert.ok(!advice.some((a) => a.slug === 'netflix'), 'netflix is clearly earning its keep');
});
