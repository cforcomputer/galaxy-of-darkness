// client/src/App.tsx
import { useMemo } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import type { DbConnection } from "./module_bindings";

import GameCanvas from "./game/GameCanvas";
import "./App.css";

export default function App() {
  const conn = useSpacetimeDB<DbConnection>();
  const { identity, isActive: connected } = conn;

  const identityHex = useMemo(() => identity?.toHexString() ?? "", [identity]);

  if (!connected || !identity) {
    // Minimal connect screen (no banner/instructions)
    return <div className="god-fullscreen" />;
  }

  return (
    <div className="god-fullscreen">
      <GameCanvas conn={conn} identityHex={identityHex} />
    </div>
  );
}
