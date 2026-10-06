/**
 * Run with `npm test`. "סימוני תזונה" and the description counter as the product form
 * edits them (lib/productDietary.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DESCRIPTION_MAX,
  DESCRIPTION_RECOMMENDED,
  DIETARY_TAGS,
  descriptionLevel,
  dietaryConflict,
  normalizeDietaryTags,
  toggleDietaryTag,
  type DietaryTag,
} from './productDietary';

describe('normalizeDietaryTags', () => {
  it('keeps known codes once, in the fixed order', () => {
    assert.deepEqual(normalizeDietaryTags(['spicy', 'kosher', 'meat', 'spicy', ' GLUTEN_FREE ']), [
      'meat',
      'gluten_free',
      'spicy',
    ]);
  });
  it('is empty for anything that is not a list', () => {
    assert.deepEqual(normalizeDietaryTags(undefined), []);
    assert.deepEqual(normalizeDietaryTags(null), []);
    assert.deepEqual(normalizeDietaryTags('vegan'), []);
  });
  it('marks a vegan dish vegetarian too', () => {
    assert.deepEqual(normalizeDietaryTags(['vegan']), ['vegan', 'vegetarian']);
  });
});

describe('toggleDietaryTag — the exclusivity rules', () => {
  it('vegan turns vegetarian on and says so', () => {
    assert.deepEqual(toggleDietaryTag([], 'vegan'), { tags: ['vegan', 'vegetarian'], added: ['vegetarian'], cleared: [] });
  });
  it('vegan clears dairy and meat', () => {
    assert.deepEqual(toggleDietaryTag(['dairy', 'spicy'], 'vegan'), {
      tags: ['vegan', 'vegetarian', 'spicy'],
      added: ['vegetarian'],
      cleared: ['dairy'],
    });
    assert.deepEqual(toggleDietaryTag(['meat'], 'vegan').cleared, ['meat']);
  });
  it('meat and dairy clear each other', () => {
    assert.deepEqual(toggleDietaryTag(['dairy'], 'meat'), { tags: ['meat'], added: [], cleared: ['dairy'] });
    assert.deepEqual(toggleDietaryTag(['meat'], 'dairy'), { tags: ['dairy'], added: [], cleared: ['meat'] });
  });
  it('dairy on a vegan dish clears vegan and keeps vegetarian', () => {
    assert.deepEqual(toggleDietaryTag(['vegan', 'vegetarian'], 'dairy'), {
      tags: ['vegetarian', 'dairy'],
      added: [],
      cleared: ['vegan'],
    });
  });
  it('meat clears vegetarian and vegan; vegetarian clears meat', () => {
    assert.deepEqual(toggleDietaryTag(['vegan', 'vegetarian', 'gluten_free'], 'meat'), {
      tags: ['meat', 'gluten_free'],
      added: [],
      cleared: ['vegan', 'vegetarian'],
    });
    assert.deepEqual(toggleDietaryTag(['meat'], 'vegetarian').cleared, ['meat']);
  });
  it('clearing vegetarian on a vegan dish clears vegan too', () => {
    assert.deepEqual(toggleDietaryTag(['vegan', 'vegetarian'], 'vegetarian'), { tags: [], added: [], cleared: ['vegan'] });
  });
  it('turning a tag off touches nothing else', () => {
    assert.deepEqual(toggleDietaryTag(['vegan', 'vegetarian', 'spicy'], 'vegan'), {
      tags: ['vegetarian', 'spicy'],
      added: [],
      cleared: [],
    });
  });
  it('gluten free and spicy go with anything', () => {
    assert.deepEqual(toggleDietaryTag(['meat'], 'spicy').tags, ['meat', 'spicy']);
    assert.deepEqual(toggleDietaryTag(['dairy'], 'gluten_free').tags, ['dairy', 'gluten_free']);
  });
  it('no sequence of taps ever leaves a contradiction', () => {
    let tags: DietaryTag[] = [];
    for (let i = 0; i < 500; i += 1) {
      const tag = DIETARY_TAGS[(i * 7 + (i >> 2)) % DIETARY_TAGS.length];
      tags = toggleDietaryTag(tags, tag).tags;
      assert.equal(dietaryConflict(tags), null, `after ${tag}: ${tags.join(',')}`);
      if (tags.includes('vegan')) assert.ok(tags.includes('vegetarian'));
    }
  });
});

describe('dietaryConflict', () => {
  it('names the first contradicting pair', () => {
    assert.deepEqual(dietaryConflict(['dairy', 'meat']), ['meat', 'dairy']);
    assert.deepEqual(dietaryConflict(['vegetarian', 'meat']), ['vegetarian', 'meat']);
    assert.equal(dietaryConflict(['vegan', 'vegetarian', 'spicy']), null);
  });
});

describe('descriptionLevel', () => {
  it('is ok up to the recommendation, long past it, over past the limit', () => {
    assert.equal(descriptionLevel(undefined), 'ok');
    assert.equal(descriptionLevel('א'.repeat(DESCRIPTION_RECOMMENDED)), 'ok');
    assert.equal(descriptionLevel('א'.repeat(DESCRIPTION_RECOMMENDED + 1)), 'long');
    assert.equal(descriptionLevel('א'.repeat(DESCRIPTION_MAX)), 'long');
    assert.equal(descriptionLevel('א'.repeat(DESCRIPTION_MAX + 1)), 'over');
  });
});
