import { useEffect, useRef, useState } from "react";
import { gatewayActivationEpoch } from "@hermes/plugin-sdk";
import { analyzeScene } from "../api";
import type { RestFn } from "../api";
import type { SceneSpec } from "../types";
import type { BudgetName, HealthReport } from "../state/health";
import { createHealthComparison } from "../state/healthComparison";
import type { HealthComparison } from "../state/healthComparison";
export interface HealthState {
  report: HealthReport | null;
  running: boolean;
  failed: boolean;
  budget: BudgetName;
  comparison: HealthComparison | null;
  costsOpen: boolean;
  setCostsOpen: (open: boolean) => void;
  setBudget: (budget: BudgetName) => void;
  run: () => Promise<void>;
}
export function useHealth(rest: RestFn, scene: SceneSpec, sourceKey = "local"): HealthState {
  const [costsOpen, setCostsOpen] = useState(false);
  const epoch = gatewayActivationEpoch();
  const [budget, setBudget] = useState<BudgetName>("mobile");
  const key = JSON.stringify([sourceKey, scene.id, scene.revision, epoch, budget]);
  const current = useRef(key); current.current = key;
  const generation = useRef(0);
  const ranRef = useRef(false);
  const comparisonRef = useRef(createHealthComparison());
  const [state, setState] = useState<{ key: string; report: HealthReport | null; running: boolean; failed: boolean; comparison: HealthComparison | null }>({ key, report: null, running: false, failed: false, comparison: null });
  async function run(): Promise<void> {
    if (current.current !== key || gatewayActivationEpoch() !== epoch) return;
    ranRef.current = true;
    const captured = key, request = ++generation.current;
    const active = () => current.current === captured && generation.current === request && gatewayActivationEpoch() === epoch;
    setState((old) => ({ key: captured, report: old.key === captured ? old.report : null, running: true, failed: false, comparison: old.key === captured ? old.comparison : null }));
    try {
      const report = await analyzeScene(rest, scene.id, { budget });
      if (!active()) return;
      if (report.scene !== scene.id || report.revision !== scene.revision || report.analysis?.budget.name !== budget) {
        setState({ key: captured, report: null, running: false, failed: true, comparison: null });
        return;
      }
      const comparison = comparisonRef.current.accept(JSON.stringify([sourceKey, epoch]), report);
      setState({ key: captured, report, running: false, failed: false, comparison });
    } catch {
      if (active()) setState({ key: captured, report: null, running: false, failed: true, comparison: null });
    }
  }
  const lastScope = useRef(JSON.stringify([sourceKey, scene.id, epoch, budget]));
  useEffect(() => {
    const scope = JSON.stringify([sourceKey, scene.id, epoch, budget]);
    if (lastScope.current !== scope) {
      const previous = JSON.parse(lastScope.current) as unknown[];
      const changedScene = previous[0] !== sourceKey || previous[1] !== scene.id || previous[2] !== epoch;
      lastScope.current = scope;
      comparisonRef.current.clear();
      ++generation.current;
      if (changedScene) { ranRef.current = false; setCostsOpen(false); }
      setState({ key, report: null, running: false, failed: false, comparison: null });
    }
    if (ranRef.current) void run();
    // Captured generation/identity guards own each completion.
    return () => { ++generation.current; };
  }, [key]);
  const shown = state.key === key ? state : { report: null, running: false, failed: false, comparison: null };
  return { ...shown, budget, setBudget, costsOpen, setCostsOpen, run };
}
