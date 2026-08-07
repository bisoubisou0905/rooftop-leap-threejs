import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeDuelLife,
  duelWaterProgressAt,
  duelWaterTimingAt,
  isPlayerCaughtByWater,
} from "../app/duel-rules.ts";

test("water gives a ten second grace period, then advances one roof every seven seconds", () => {
  assert.equal(duelWaterProgressAt(0, 18), -1);
  assert.equal(duelWaterProgressAt(10, 18), 0);
  assert.equal(duelWaterProgressAt(17, 18), 1);
  assert.equal(duelWaterProgressAt(24, 18), 2);
  assert.equal(duelWaterProgressAt(200, 18), 18);
});

test("water timing reports the next advance and its readable phase", () => {
  assert.deepEqual(duelWaterTimingAt(0, 18), {
    progress: -1,
    nextAdvanceIn: 10,
    phaseProgress: 0,
  });
  assert.deepEqual(duelWaterTimingAt(7.5, 18), {
    progress: -0.25,
    nextAdvanceIn: 2.5,
    phaseProgress: 0.75,
  });
  assert.deepEqual(duelWaterTimingAt(13.5, 18), {
    progress: 0.5,
    nextAdvanceIn: 3.5,
    phaseProgress: 0.5,
  });
  assert.deepEqual(duelWaterTimingAt(200, 18), {
    progress: 18,
    nextAdvanceIn: 0,
    phaseProgress: 1,
  });
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
