import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { resolveSecurityWindow, validateOpenSecurityFilter } from './security-window';

const NOW = Date.parse('2026-07-17T12:00:00.000Z');

describe('resolveSecurityWindow', () => {
  it('uses the requested custom endTime instead of the current time', () => {
    const window = resolveSecurityWindow({
      timeType: 'custom',
      startTime: '2026-07-16T01:00:00.000Z',
      endTime: '2026-07-16T02:00:00.000Z',
    }, NOW);

    assert.deepEqual(window, {
      sinceMs: Date.parse('2026-07-16T01:00:00.000Z'),
      endMs: Date.parse('2026-07-16T02:00:00.000Z'),
      spanMs: 60 * 60_000,
    });
  });

  it('uses now as the end of a shortcut window', () => {
    assert.deepEqual(resolveSecurityWindow({ timeType: 'last_3h' }, NOW), {
      sinceMs: NOW - 3 * 60 * 60_000,
      endMs: NOW,
      spanMs: 3 * 60 * 60_000,
    });
  });

  it('defaults to the last three hours', () => {
    assert.deepEqual(resolveSecurityWindow({}, NOW), {
      sinceMs: NOW - 3 * 60 * 60_000,
      endMs: NOW,
      spanMs: 3 * 60 * 60_000,
    });
  });
});

describe('validateOpenSecurityFilter', () => {
  it('accepts the documented request fields', () => {
    assert.doesNotThrow(() => validateOpenSecurityFilter({
      timeType: 'custom',
      startTime: '2026-07-16T01:00:00Z',
      endTime: '2026-07-16T02:00:00Z',
      seriesPoints: 20,
    }, true));
  });

  it('treats nullable and blank timestamps as omitted', () => {
    assert.deepEqual(validateOpenSecurityFilter({
      timeType: 'last_3h',
      startTime: null,
      endTime: null,
      seriesPoints: 10,
    }, true), {
      timeType: 'last_3h',
      seriesPoints: 10,
    });

    assert.deepEqual(validateOpenSecurityFilter({
      timeType: 'last_3h',
      startTime: '',
      endTime: '   ',
    }), {
      timeType: 'last_3h',
    });
  });

  it('rejects unknown time types', () => {
    assert.throws(() => validateOpenSecurityFilter({ timeType: 'forever' }), BadRequestException);
  });

  it('rejects invalid timestamps and reversed custom windows', () => {
    assert.throws(() => validateOpenSecurityFilter({ timeType: 'custom', startTime: 'invalid' }), BadRequestException);
    assert.throws(() => validateOpenSecurityFilter({
      timeType: 'custom',
      startTime: '2026-07-16T03:00:00Z',
      endTime: '2026-07-16T02:00:00Z',
    }), BadRequestException);
  });

  it('rejects invalid explainability series point counts', () => {
    assert.throws(() => validateOpenSecurityFilter({ seriesPoints: 0 }, true), BadRequestException);
    assert.throws(() => validateOpenSecurityFilter({ seriesPoints: '20' }, true), BadRequestException);
  });
});
