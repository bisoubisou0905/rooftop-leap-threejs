export type SurfaceShape = "rect" | "circle" | "hex";

export type PlatformSurface = {
  x: number;
  z: number;
  width: number;
  depth: number;
  shape: SurfaceShape;
  cornerRadius?: number;
};

export type FootSweepPoint = {
  x: number;
  y: number;
  z: number;
};

export type VerticalCollisionProfile = PlatformSurface & {
  topY: number;
  bottomY: number;
};

export type SideSweepContact = {
  time: number;
  x: number;
  z: number;
  normalX: number;
  normalZ: number;
};

export type FootSweepContact = {
  valid: boolean;
  centerSupported: boolean;
  supportCount: number;
  coverage: number;
  time: number;
  x: number;
  z: number;
  soleCenterX: number;
  soleCenterZ: number;
};

export type PlayerCollisionBody = {
  x: number;
  z: number;
  velocityX: number;
  velocityZ: number;
  radius: number;
  mass: number;
};

export type PlayerCollisionResult = {
  normalX: number;
  normalZ: number;
  overlap: number;
  localPositionX: number;
  localPositionZ: number;
  remotePositionX: number;
  remotePositionZ: number;
  localVelocityX: number;
  localVelocityZ: number;
  remoteVelocityX: number;
  remoteVelocityZ: number;
  impactSpeed: number;
};

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function dragDistanceToCharge(distance: number) {
  const linearCharge = clamp01((distance - 2.5) / 193.5);
  return Math.pow(linearCharge, 1.25);
}

export function resolveWeightedPlayerCollision(
  local: PlayerCollisionBody,
  remote: PlayerCollisionBody,
  restitution = 0.08,
  maxVelocityChange = 0.72,
): PlayerCollisionResult | null {
  const deltaX = local.x - remote.x;
  const deltaZ = local.z - remote.z;
  const minimumDistance = local.radius + remote.radius;
  const distance = Math.hypot(deltaX, deltaZ);
  if (distance >= minimumDistance) return null;

  let normalX = distance > 1e-5 ? deltaX / distance : 1;
  let normalZ = distance > 1e-5 ? deltaZ / distance : 0;
  if (!Number.isFinite(normalX + normalZ)) {
    normalX = 1;
    normalZ = 0;
  }

  const localMass = Math.max(0.1, local.mass);
  const remoteMass = Math.max(0.1, remote.mass);
  const inverseLocalMass = 1 / localMass;
  const inverseRemoteMass = 1 / remoteMass;
  const inverseMassTotal = inverseLocalMass + inverseRemoteMass;
  const relativeNormalSpeed =
    (local.velocityX - remote.velocityX) * normalX +
    (local.velocityZ - remote.velocityZ) * normalZ;
  const impactSpeed = Math.max(0, -relativeNormalSpeed);
  const rawImpulse = impactSpeed > 0
    ? ((1 + clamp01(restitution)) * impactSpeed) / inverseMassTotal
    : 0;
  const maximumImpulse = maxVelocityChange / Math.max(
    inverseLocalMass,
    inverseRemoteMass,
  );
  const impulse = Math.min(rawImpulse, maximumImpulse);
  const localVelocityChange = impulse * inverseLocalMass;
  const remoteVelocityChange = impulse * inverseRemoteMass;

  const overlap = minimumDistance - distance;
  const correction = Math.min(0.09, Math.max(0, overlap - 0.006) * 0.56);
  const localCorrection = correction * (inverseLocalMass / inverseMassTotal);
  const remoteCorrection = correction * (inverseRemoteMass / inverseMassTotal);

  return {
    normalX,
    normalZ,
    overlap,
    localPositionX: local.x + normalX * localCorrection,
    localPositionZ: local.z + normalZ * localCorrection,
    remotePositionX: remote.x - normalX * remoteCorrection,
    remotePositionZ: remote.z - normalZ * remoteCorrection,
    localVelocityX: local.velocityX + normalX * localVelocityChange,
    localVelocityZ: local.velocityZ + normalZ * localVelocityChange,
    remoteVelocityX: remote.velocityX - normalX * remoteVelocityChange,
    remoteVelocityZ: remote.velocityZ - normalZ * remoteVelocityChange,
    impactSpeed,
  };
}

export function chargeToLaunch(charge: number) {
  const effectiveCharge = Math.max(0.004, clamp01(charge));
  return {
    speed: 0.12 + Math.pow(effectiveCharge, 0.82) * 6.24,
    lift: 1.58 + Math.pow(effectiveCharge, 0.58) * 4.47,
  };
}

function pointInRegularPolygon(
  x: number,
  z: number,
  radius: number,
  sides: number,
  rotation: number,
) {
  let sign = 0;
  for (let index = 0; index < sides; index += 1) {
    const angleA = rotation + (index / sides) * Math.PI * 2;
    const angleB = rotation + ((index + 1) / sides) * Math.PI * 2;
    const ax = Math.cos(angleA) * radius;
    const az = Math.sin(angleA) * radius;
    const bx = Math.cos(angleB) * radius;
    const bz = Math.sin(angleB) * radius;
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (Math.abs(cross) < 1e-8) continue;
    const edgeSign = Math.sign(cross);
    if (sign === 0) sign = edgeSign;
    else if (edgeSign !== sign) return false;
  }
  return true;
}

export function pointOnPlatformSurface(
  surface: PlatformSurface,
  x: number,
  z: number,
  margin = 0,
) {
  const localX = x - surface.x;
  const localZ = z - surface.z;

  if (surface.shape === "circle") {
    const radius = Math.max(0, surface.width / 2 + margin);
    return localX * localX + localZ * localZ <= radius * radius;
  }

  if (surface.shape === "hex") {
    const radius = Math.max(0, surface.width / 2 + margin);
    return pointInRegularPolygon(localX, localZ, radius, 6, Math.PI / 6);
  }

  const halfWidth = Math.max(0, surface.width / 2 + margin);
  const halfDepth = Math.max(0, surface.depth / 2 + margin);
  const cornerRadius = Math.min(
    surface.cornerRadius ?? 0.055,
    halfWidth,
    halfDepth,
  );
  const qx = Math.abs(localX) - (halfWidth - cornerRadius);
  const qz = Math.abs(localZ) - (halfDepth - cornerRadius);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) <= cornerRadius;
}

function closestPointOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
) {
  const edgeX = bx - ax;
  const edgeZ = bz - az;
  const edgeLengthSquared = edgeX * edgeX + edgeZ * edgeZ;
  const time = edgeLengthSquared > 1e-8
    ? clamp01(((px - ax) * edgeX + (pz - az) * edgeZ) / edgeLengthSquared)
    : 0;
  return { x: ax + edgeX * time, z: az + edgeZ * time };
}

export function resolveCircleSurfaceCollision(
  surface: PlatformSurface,
  x: number,
  z: number,
  radius: number,
  velocityX: number,
  velocityZ: number,
): Omit<SideSweepContact, "time"> | null {
  const localX = x - surface.x;
  const localZ = z - surface.z;

  if (surface.shape === "circle") {
    const solidRadius = surface.width / 2;
    const distance = Math.hypot(localX, localZ);
    if (distance >= solidRadius + radius) return null;
    let normalX = distance > 1e-5 ? localX / distance : -Math.sign(velocityX);
    let normalZ = distance > 1e-5 ? localZ / distance : -Math.sign(velocityZ);
    if (Math.abs(normalX) + Math.abs(normalZ) < 1e-4) normalZ = -1;
    const normalLength = Math.hypot(normalX, normalZ);
    normalX /= normalLength;
    normalZ /= normalLength;
    return {
      x: surface.x + normalX * (solidRadius + radius),
      z: surface.z + normalZ * (solidRadius + radius),
      normalX,
      normalZ,
    };
  }

  if (surface.shape === "hex") {
    const polygonRadius = surface.width / 2;
    const rotation = Math.PI / 6;
    const inside = pointInRegularPolygon(localX, localZ, polygonRadius, 6, rotation);
    let closestX = 0;
    let closestZ = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < 6; index += 1) {
      const angleA = rotation + (index / 6) * Math.PI * 2;
      const angleB = rotation + ((index + 1) / 6) * Math.PI * 2;
      const closest = closestPointOnSegment(
        localX,
        localZ,
        Math.cos(angleA) * polygonRadius,
        Math.sin(angleA) * polygonRadius,
        Math.cos(angleB) * polygonRadius,
        Math.sin(angleB) * polygonRadius,
      );
      const distance = Math.hypot(localX - closest.x, localZ - closest.z);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestX = closest.x;
        closestZ = closest.z;
      }
    }
    if (!inside && closestDistance >= radius) return null;
    let normalX = inside ? closestX - localX : localX - closestX;
    let normalZ = inside ? closestZ - localZ : localZ - closestZ;
    const normalLength = Math.hypot(normalX, normalZ);
    if (normalLength < 1e-5) {
      normalX = -Math.sign(velocityX);
      normalZ = -Math.sign(velocityZ);
    } else {
      normalX /= normalLength;
      normalZ /= normalLength;
    }
    if (Math.abs(normalX) + Math.abs(normalZ) < 1e-4) normalZ = -1;
    return {
      x: surface.x + closestX + normalX * radius,
      z: surface.z + closestZ + normalZ * radius,
      normalX,
      normalZ,
    };
  }

  const halfWidth = surface.width / 2;
  const halfDepth = surface.depth / 2;
  const closestX = Math.min(halfWidth, Math.max(-halfWidth, localX));
  const closestZ = Math.min(halfDepth, Math.max(-halfDepth, localZ));
  const cornerX = localX - closestX;
  const cornerZ = localZ - closestZ;
  const cornerDistance = Math.hypot(cornerX, cornerZ);

  if (cornerDistance > 1e-5) {
    if (cornerDistance >= radius) return null;
    const normalX = cornerX / cornerDistance;
    const normalZ = cornerZ / cornerDistance;
    return {
      x: surface.x + closestX + normalX * radius,
      z: surface.z + closestZ + normalZ * radius,
      normalX,
      normalZ,
    };
  }

  const exitX = halfWidth - Math.abs(localX);
  const exitZ = halfDepth - Math.abs(localZ);
  if (exitX < exitZ) {
    const normalX = Math.sign(localX) || (velocityX >= 0 ? -1 : 1);
    return {
      x: surface.x + normalX * (halfWidth + radius),
      z,
      normalX,
      normalZ: 0,
    };
  }
  const normalZ = Math.sign(localZ) || (velocityZ >= 0 ? -1 : 1);
  return {
    x,
    z: surface.z + normalZ * (halfDepth + radius),
    normalX: 0,
    normalZ,
  };
}

export function sweepBodyAgainstProfile(
  profile: VerticalCollisionProfile,
  previous: FootSweepPoint,
  current: FootSweepPoint,
  radius = 0.18,
  bodyOffsets: readonly number[] = [0.16, 0.48, 0.82, 1.12],
): SideSweepContact | null {
  const deltaX = current.x - previous.x;
  const deltaY = current.y - previous.y;
  const deltaZ = current.z - previous.z;
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.hypot(deltaX, deltaZ), Math.abs(deltaY)) / 0.045),
  );

  for (let step = 0; step <= steps; step += 1) {
    const time = step / steps;
    const x = previous.x + deltaX * time;
    const y = previous.y + deltaY * time;
    const z = previous.z + deltaZ * time;
    const overlapsVertically = bodyOffsets.some((offset) => {
      const sampleY = y + offset;
      return sampleY > profile.bottomY - radius * 0.2 &&
        sampleY < profile.topY + radius * 0.2;
    });
    if (!overlapsVertically) continue;

    const collision = resolveCircleSurfaceCollision(
      profile,
      x,
      z,
      radius,
      deltaX,
      deltaZ,
    );
    if (!collision) continue;
    const movingIntoSurface =
      deltaX * collision.normalX + deltaZ * collision.normalZ < -1e-5;
    if (step === 0 && !movingIntoSurface) continue;
    return { time, ...collision };
  }

  return null;
}

export function footSweepContact(
  surface: PlatformSurface,
  surfaceY: number,
  previousPoints: readonly FootSweepPoint[],
  currentPoints: readonly FootSweepPoint[],
  horizontalTolerance = 0.012,
  verticalTolerance = 0.018,
): FootSweepContact {
  if (previousPoints.length !== currentPoints.length || previousPoints.length === 0) {
    throw new Error("Foot sweep frames must contain the same non-zero sample count.");
  }

  let supportCount = 0;
  let centerSupported = false;
  let earliestTime = Number.POSITIVE_INFINITY;
  let supportX = 0;
  let supportZ = 0;

  // First find when any descending part of the physical sole reaches the roof.
  // The support test below then evaluates the whole projected footprint at that
  // one instant; counting only the points that crossed in a single frame made
  // angled shoes produce inconsistent edge results.
  for (let index = 0; index < previousPoints.length; index += 1) {
    const previous = previousPoints[index];
    const current = currentPoints[index];
    const deltaY = current.y - previous.y;
    if (deltaY >= -1e-6) continue;
    if (
      previous.y < surfaceY - verticalTolerance ||
      current.y > surfaceY + verticalTolerance
    ) {
      continue;
    }

    const time = clamp01((surfaceY - previous.y) / deltaY);
    earliestTime = Math.min(earliestTime, time);
  }

  if (!Number.isFinite(earliestTime)) {
    return {
      valid: false,
      centerSupported: false,
      supportCount: 0,
      coverage: 0,
      time: 1,
      x: currentPoints[0].x,
      z: currentPoints[0].z,
      soleCenterX: currentPoints[0].x,
      soleCenterZ: currentPoints[0].z,
    };
  }

  const soleCenterX =
    previousPoints[0].x + (currentPoints[0].x - previousPoints[0].x) * earliestTime;
  const soleCenterZ =
    previousPoints[0].z + (currentPoints[0].z - previousPoints[0].z) * earliestTime;

  for (let index = 0; index < previousPoints.length; index += 1) {
    const previous = previousPoints[index];
    const current = currentPoints[index];
    const x = previous.x + (current.x - previous.x) * earliestTime;
    const z = previous.z + (current.z - previous.z) * earliestTime;
    if (!pointOnPlatformSurface(surface, x, z, horizontalTolerance)) continue;

    supportCount += 1;
    centerSupported ||= index === 0;
    supportX += x;
    supportZ += z;
  }

  const minimumSupportCount = Math.max(2, Math.ceil(previousPoints.length * 0.32));
  const valid = supportCount >= minimumSupportCount;
  return {
    valid,
    centerSupported,
    supportCount,
    coverage: supportCount / previousPoints.length,
    time: valid ? earliestTime : 1,
    x: supportCount > 0 ? supportX / supportCount : currentPoints[0].x,
    z: supportCount > 0 ? supportZ / supportCount : currentPoints[0].z,
    soleCenterX,
    soleCenterZ,
  };
}
