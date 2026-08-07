import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeDuelLife,
  duelWaterProgressAt,
  isPlayerCaughtByWater,
} from "../app/duel-rules.ts";

test("water floods the starting roof, then advances one roof every five seconds", () => {
  assert.equal(duelWaterProgressAt(0, 18), -1);
  assert.equal(duelWaterProgressAt(6, 18), 0);
  assert.equal(duelWaterProgressAt(11, 18), 1);
  assert.equal(duelWaterProgressAt(16, 18), 2);
  assert.equal(duelWaterProgressAt(200, 18), 18);
});

test("three misses consume all three lives", () => {
  const first = consumeDuelLife(3);
  const second = consumeDuelLife(first.lives);
  const third = consumeDuelLife(second.lives);
  assert.deepEqual(first, { lives: 2, eliminated: false });
  assert.deepEqual(second, { lives: 1, eliminated: false });
  assert.deepEqual(third, { lives: 0, eliminated: true });
});

test("water checks the visible sole height instead of the previous platform", () => {
  assert.equal(isPlayerCaughtByWater(1.2, 0.8), false);
  assert.equal(isPlayerCaughtByWater(0.84, 0.8), true);
});
