// client/src/esi.ts
export type Vec3M = { x: number; y: number; z: number };

export type CelestialKind = "star" | "planet" | "moon" | "stargate" | "station";

export type Celestial = {
  id: number;
  kind: CelestialKind;
  name: string;
  position_m: Vec3M;

  // Present for most things (planet/stargate/station; star has it too)
  type_id?: number;

  // Real radius in meters when we can resolve it
  radius_m?: number;
};

export type SystemScene = {
  systemId: number;
  systemName: string;
  celestials: Celestial[];
};

const ESI_BASE = "https://esi.evetech.net/latest";
const DATASOURCE = "tranquility";

async function esiGet<T>(path: string): Promise<T> {
  const url = `${ESI_BASE}${path}${
    path.includes("?") ? "&" : "?"
  }datasource=${DATASOURCE}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ESI ${res.status} for ${path}: ${txt}`);
  }
  return (await res.json()) as T;
}

// Dogma attribute 162 = radius (meters)
const DOGMA_RADIUS_ATTR_ID = 162;
const typeRadiusCache = new Map<number, number | null>();

type UniverseType = {
  type_id: number;
  name: string;
  dogma_attributes?: Array<{ attribute_id: number; value: number }>;
};

async function getTypeRadiusMeters(typeId: number): Promise<number | null> {
  if (typeRadiusCache.has(typeId)) return typeRadiusCache.get(typeId)!;

  try {
    const t = await esiGet<UniverseType>(`/universe/types/${typeId}/`);
    const v =
      t.dogma_attributes?.find((a) => a.attribute_id === DOGMA_RADIUS_ATTR_ID)
        ?.value ?? null;

    // value is already in meters for radius attribute
    typeRadiusCache.set(typeId, typeof v === "number" ? v : null);
    return typeof v === "number" ? v : null;
  } catch {
    typeRadiusCache.set(typeId, null);
    return null;
  }
}

type UniverseSystem = {
  name: string;
  system_id: number;
  star_id?: number;
  planets?: Array<{
    planet_id: number;
    moons?: number[];
    asteroid_belts?: number[];
  }>;
  stargates?: number[];
  stations?: number[];
};

type UniversePlanet = {
  planet_id: number;
  name: string;
  position: Vec3M;
  system_id: number;
  type_id: number;
};

type UniverseMoon = {
  moon_id: number;
  name: string;
  position: Vec3M;
  system_id: number;
};

type UniverseStargate = {
  stargate_id: number;
  name: string;
  position: Vec3M;
  system_id: number;
  type_id: number;
  destination: unknown;
};

type UniverseStation = {
  station_id: number;
  name: string;
  position: Vec3M;
  system_id: number;
  type_id: number;
};

type UniverseStar = {
  name: string;
  radius: number; // meters
  type_id: number;
  solar_system_id: number;
};

export async function loadSystemScene(systemId: number): Promise<SystemScene> {
  const sys = await esiGet<UniverseSystem>(`/universe/systems/${systemId}/`);

  const celestials: Celestial[] = [];

  // Star (no position in star endpoint; in-space map typically uses star at origin for system-local scene)
  if (sys.star_id) {
    try {
      const star = await esiGet<UniverseStar>(`/universe/stars/${sys.star_id}/`);
      celestials.push({
        id: sys.star_id,
        kind: "star",
        name: star.name,
        position_m: { x: 0, y: 0, z: 0 },
        type_id: star.type_id,
        radius_m: star.radius,
      });
    } catch {
      celestials.push({
        id: sys.star_id,
        kind: "star",
        name: `${sys.name} - Star`,
        position_m: { x: 0, y: 0, z: 0 },
      });
    }
  }

  // Planets (+ moons)
  const planetIds = (sys.planets ?? []).map((p) => p.planet_id);
  const planetInfos = await Promise.all(
    planetIds.map(async (pid) => {
      try {
        return await esiGet<UniversePlanet>(`/universe/planets/${pid}/`);
      } catch {
        return null;
      }
    })
  );

  for (const p of planetInfos) {
    if (!p) continue;

    const radius_m = await getTypeRadiusMeters(p.type_id);

    celestials.push({
      id: p.planet_id,
      kind: "planet",
      name: p.name,
      position_m: p.position,
      type_id: p.type_id,
      radius_m: radius_m ?? undefined,
    });
  }

  // Moons (ESI moon endpoint has no type_id => no true radius available via ESI alone)
  const moonIds = (sys.planets ?? []).flatMap((p) => p.moons ?? []);
  const moonInfos = await Promise.all(
    moonIds.map(async (mid) => {
      try {
        return await esiGet<UniverseMoon>(`/universe/moons/${mid}/`);
      } catch {
        return null;
      }
    })
  );

  for (const m of moonInfos) {
    if (!m) continue;
    celestials.push({
      id: m.moon_id,
      kind: "moon",
      name: m.name,
      position_m: m.position,
    });
  }

  // Stargates
  const gateIds = sys.stargates ?? [];
  const gateInfos = await Promise.all(
    gateIds.map(async (gid) => {
      try {
        return await esiGet<UniverseStargate>(`/universe/stargates/${gid}/`);
      } catch {
        return null;
      }
    })
  );

  for (const g of gateInfos) {
    if (!g) continue;
    const radius_m = await getTypeRadiusMeters(g.type_id);
    celestials.push({
      id: g.stargate_id,
      kind: "stargate",
      name: g.name,
      position_m: g.position,
      type_id: g.type_id,
      radius_m: radius_m ?? undefined,
    });
  }

  // Stations
  const stationIds = sys.stations ?? [];
  const stationInfos = await Promise.all(
    stationIds.map(async (sid) => {
      try {
        return await esiGet<UniverseStation>(`/universe/stations/${sid}/`);
      } catch {
        return null;
      }
    })
  );

  for (const s of stationInfos) {
    if (!s) continue;
    const radius_m = await getTypeRadiusMeters(s.type_id);
    celestials.push({
      id: s.station_id,
      kind: "station",
      name: s.name,
      position_m: s.position,
      type_id: s.type_id,
      radius_m: radius_m ?? undefined,
    });
  }

  return {
    systemId,
    systemName: sys.name,
    celestials,
  };
}
