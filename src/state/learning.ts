import { useSyncExternalStore } from "react";
import type { PrefsStorage } from "./viewPrefs";
export type LearningStep = "look" | "select" | "move" | "color" | "save";
export interface HelpState { pending: string[]; steps: LearningStep[]; hidden: boolean; tips: string[]; showTips: boolean; collapsed: boolean }
let storage: PrefsStorage | null = null;
let state: HelpState = { pending: [], steps: [], hidden: false, tips: [], showTips: true, collapsed: true };
const listeners = new Set<() => void>();
export function initLearning(value?: PrefsStorage | null) {
 storage = value ?? null;
 let saved: Partial<HelpState> = {};
 let tips: unknown = [];
 try { saved = storage?.get<Partial<HelpState>>("help.checklist", {}) ?? {}; tips = storage?.get<unknown>("help.tips", []) ?? []; } catch { /* Session defaults remain usable when storage is unavailable. */ }
 if (!saved || typeof saved !== "object") saved = {};
 state = { pending: [], steps: Array.isArray(saved.steps) ? [...new Set(saved.steps.filter(s => ["look","select","move","color","save"].includes(s)))] : [], hidden: saved.hidden === true, tips: Array.isArray(tips) ? tips.filter((tip): tip is string => typeof tip === "string") : [], showTips: saved.showTips !== false, collapsed: saved.collapsed !== false };
 for (const fn of listeners) fn();
}
function write(patch: Partial<HelpState>) { state = { ...state, ...patch }; try { storage?.set("help.checklist", state); storage?.set("help.tips", state.tips); } catch { /* Keep help available for this session. */ } for (const fn of listeners) fn(); }
export function markLearning(step: LearningStep) { if (!state.steps.includes(step)) write({ steps: [...state.steps, step] }); }
export function setHelp(patch: Partial<HelpState>) { write(patch); }
export function seenTip(id: string) { if (!state.tips.includes(id)) write({ tips: [...state.tips, id], pending: state.pending.filter(value => value !== id) }); }
export function useLearning() { return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state); }

export function offerTip(id: string) { if (!state.tips.includes(id) && !state.pending.includes(id)) write({ pending: [...state.pending, id] }); }

export function getLearning(): HelpState { return state; }
