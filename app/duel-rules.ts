export const DUEL_STARTING_LIVES = 3;
export const DUEL_WATER_START_LEVEL = -0.62;
export const DUEL_WATER_GRACE_SECONDS = 10;
export const DUEL_WATER_SECONDS_PER_STEP = 7;

export function consumeDuelLife(currentLives: number) {
  const lives = Math.max(0, Math.min(DUEL_STARTING_LIVES, Math.round(currentLives)) - 1);
  return { lives, eliminated: lives === 0 };
}

export function duelWaterProgressAt(
  elapsedSeconds: number,
  finishStep: number,
) {
  const safeElapsed = Math.max(0, elapsedSeconds);
  const rawProgress = safeElapsed < DUEL_WATER_GRACE_SECONDS
    ? -1 + safeElapsed / DUEL_WATER_GRACE_SECONDS
    : (safeElapsed - DUEL_WATER_GRACE_SECONDS) / DUEL_WATER_SECONDS_PER_STEP;
  return Math.min(Math.max(-1, rawProgress), Math.max(0, finishStep));
}

export function duelWaterTimingAt(
  elapsedSeconds: number,
  finishStep: number,
) {
  const safeElapsed = Math.max(0, elapsedSeconds);
  const progress = duelWaterProgressAt(safeElapsed, finishStep);
  if (progress >= finishStep) {
    return { progress, nextAdvanceIn: 0, phaseProgress: 1 };
  }
  if (safeElapsed < DUEL_WATER_GRACE_SECONDS) {
    return {
      progress,
      nextAdvanceIn: DUEL_WATER_GRACE_SECONDS - safeElapsed,
      phaseProgress: safeElapsed / DUEL_WATER_GRACE_SECONDS,
    };
  }
  const stepElapsed = (safeElapsed - DUEL_WATER_GRACE_SECONDS) %
    DUEL_WATER_SECONDS_PER_STEP;
  return {
    progress,
    nextAdvanceIn: DUEL_WATER_SECONDS_PER_STEP - stepElapsed,
    phaseProgress: stepElapsed / DUEL_WATER_SECONDS_PER_STEP,
  };
}

export function isPlayerCaughtByWater(
  soleHeight: number,
  waterLevel: number,
  contactTolerance = 0.055,
) {
  return soleHeight <= waterLevel + contactTolerance;
}
