import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addInterval, daysBetween, drugAliases, drugKey, findDates, parseDose, parseFrequency, parseRange, quoteInText, rangeStatus, relativeFromText, resolveToday,
} from '../src/normalize.js';

test('frequency: words, abbreviations, schedules and intervals map to doses per day', () => {
  const per = (s) => parseFrequency(s).perDay;
  assert.equal(per('Take medicine X twice daily'), 2);
  assert.equal(per('take once daily in the morning'), 1);
  assert.equal(per('1 tab BD after food'), 2);
  assert.equal(per('1-0-1 after meals'), 2);
  assert.equal(per('every 8 hours'), 3);
  assert.equal(per('q12h'), 2);
  assert.equal(per('three times a day'), 3);
  assert.equal(per('at bedtime'), 1);
  assert.ok(Math.abs(per('once weekly') - 1 / 7) < 1e-9);
  assert.equal(per('as needed for pain'), null);
  assert.equal(parseFrequency('paracetamol as needed').asNeeded, true);
  assert.equal(per('Check blood sugar'), null);
});

test('dose parsing normalises units', () => {
  assert.deepEqual(parseDose('Metformin 500 mg'), { amount: 500, unit: 'mg', text: '500 mg' });
  assert.equal(parseDose('1 g').amount, 1000);
  assert.equal(parseDose('250 mcg').amount, 0.25);
  assert.equal(parseDose('no number here'), null);
});

test('dates: several formats, ambiguous day/month is not guessed', () => {
  const iso = (s) => findDates(s)[0]?.iso;
  assert.equal(iso('Date: 13 Sep 2026'), '2026-09-13');
  assert.equal(iso('September 13th, 2026'), '2026-09-13');
  assert.equal(iso('2026-09-13'), '2026-09-13');
  assert.equal(iso('25/12/2026'), '2026-12-25');
  assert.equal(iso('12/25/2026'), '2026-12-25');
  const amb = findDates('05/06/2026')[0];
  assert.equal(amb.iso, null);
  assert.equal(amb.ambiguous, true);
  assert.equal(iso('31 Feb 2026'), null);
});

test('date arithmetic', () => {
  assert.equal(addInterval('2026-09-22', 2, 'weeks'), '2026-10-06');
  assert.equal(addInterval('2026-01-31', 1, 'month'), '2026-02-28');
  assert.equal(daysBetween('2026-10-04', '2026-10-06'), 2);
  assert.deepEqual(relativeFromText('after 6 weeks').amount, 6);
  assert.equal(relativeFromText('in two months').unit, 'month');
  assert.equal(resolveToday('2026-10-05', new Date('2026-10-04T12:00:00Z')), '2026-10-05');
  assert.equal(resolveToday('1999-01-01', new Date('2026-10-04T12:00:00Z')), '2026-10-04');
});

test('drug names: forms, strengths and salts are ignored; brackets give aliases', () => {
  assert.equal(drugKey('Tab. Metformin 500 mg'), 'metformin');
  assert.equal(drugKey('Metformin Hydrochloride'), 'metformin');
  assert.equal(drugKey('medicine X'), 'x');
  assert.equal(drugKey('Acetaminophen'), 'paracetamol');
  assert.deepEqual(drugAliases('Glycomet (Metformin)').sort(), ['glycomet', 'metformin']);
});

test('ranges and flags are calculated, never guessed', () => {
  assert.deepEqual(parseRange('13.0 - 17.0'), { low: 13, high: 17 });
  assert.equal(rangeStatus('8.2', parseRange('4.0 - 5.6')), 'high');
  assert.equal(rangeStatus('52', parseRange('> 60')), 'low');
  assert.equal(rangeStatus('96', parseRange('< 100')), 'in');
  assert.equal(rangeStatus('abc', parseRange('1-2')), null);
  assert.equal(rangeStatus('5', null), null);
});

test('quote matching ignores spacing, punctuation and case but not content', () => {
  const page = 'Take  metformin\n500 mg twice daily,\nafter meals.';
  assert.ok(quoteInText('Take metformin 500 mg twice daily', page));
  assert.ok(!quoteInText('Take metformin 500 mg once daily', page));
  assert.ok(!quoteInText('abc', 'abc def'));
});
