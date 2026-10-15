import assert from 'node:assert/strict';
import test from 'node:test';
import { foundingPropertyPreviewReady, validateFoundingPropertyDraft } from './founding-property-draft.ts';
test('valid property draft', () => {
  assert.deepEqual(validateFoundingPropertyDraft({ name: 'Aegean Bay', locality: 'Kos', code: 'aegean-bay' }), {});
});
test('invalid property drafts are rejected', () => {
  for (const code of ['', 'Aegean', 'a', 'hotel_', 'hotel-', 'x'.repeat(33)]) {
    assert.ok(validateFoundingPropertyDraft({ name: 'Hotel', locality: 'Kos', code }).code);
  }
  assert.ok(validateFoundingPropertyDraft({ name: ' ', locality: 'Kos', code: 'hotel-1' }).name);
  assert.ok(validateFoundingPropertyDraft({ name: 'Hotel', locality: ' ', code: 'hotel-1' }).locality);
});

test('preview readiness reflects only valid fields, not legal authority', () => {
  assert.equal(foundingPropertyPreviewReady({ name: 'Hotel', locality: 'Kos', code: 'hotel-kos' }), true);
  assert.equal(foundingPropertyPreviewReady({ name: 'Hotel', locality: 'Kos', code: 'hotel-' }), false);
  assert.equal(foundingPropertyPreviewReady({ name: '', locality: 'Kos', code: 'hotel-kos' }), false);
});
