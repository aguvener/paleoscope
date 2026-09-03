import assert from 'node:assert/strict';
import test from 'node:test';

import { validate } from '../src/agent/webmcp.ts';

const schema = {
  type: 'object' as const,
  properties: {
    count: { type: 'integer' as const, description: 'Count', minimum: 1, maximum: 10, default: 3 },
    tags: { type: 'array' as const, description: 'Tags', items: { type: 'string' as const }, maxItems: 2 },
  },
};

test('validate applies defaults and clamps integers', () => {
  assert.deepEqual(validate({}, schema), { ok: true, value: { count: 3 } });
  assert.deepEqual(validate({ count: 99 }, schema), { ok: true, value: { count: 10 } });
});

test('validate rejects a wrong type and oversized array', () => {
  assert.equal(validate({ tags: 'x' }, schema).ok, false);
  assert.equal(validate({ tags: ['a', 'b', 'c'] }, schema).ok, false);
});

test('validate rejects an undeclared argument instead of dropping it', () => {
  const result = validate({ population: 'Yamnaya', region: 'anatolia' }, {
    type: 'object',
    properties: { population: { type: 'string', description: '' } },
  });
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Unknown argument "region"/);
  assert.match((result as { hint: string }).hint, /Accepted arguments: population/);
});
