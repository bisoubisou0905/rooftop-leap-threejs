import assert from "node:assert/strict";
import test from "node:test";
import { makeDuelMatchId, normalizeDuelRoom } from "../app/duel-room.ts";

test("duel room links normalize to one stable broker topic", () => {
  assert.equal(normalizeDuelRoom("  Yao 0905  "), "yao-0905");
  assert.equal(normalizeDuelRoom("FRIENDS---NIGHT"), "friends-night");
  assert.equal(normalizeDuelRoom(""), "quick-0905");
});

test("match IDs are deterministic regardless of who offers first", () => {
  assert.equal(makeDuelMatchId("rl-z", "rl-a"), "rl-a-rl-z");
  assert.equal(
    makeDuelMatchId("rl-a", "rl-z"),
    makeDuelMatchId("rl-z", "rl-a"),
  );
});

test("room names are bounded before becoming public relay topics", () => {
  const room = normalizeDuelRoom("This room name is deliberately far too long!");
  assert.equal(room.length, 24);
  assert.match(room, /^[a-z0-9-]+$/);
});
