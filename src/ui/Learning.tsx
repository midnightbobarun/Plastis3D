import { LEARNING_COPY as L } from "../copy";
import { useEffect, useRef, useState } from "react";
import { host, KbdGroup, writeClipboardText } from "@hermes/plugin-sdk";
import { markLearning, seenTip as importSeen, setHelp, useLearning } from "../state/learning";
import { handoffPrompt } from "../io/composerHandoff";
export const CREATE_PROMPTS = L.createPrompts;
export const EDIT_PROMPTS = L.editPrompts;
// Temporarily hide prompt entry points until the chat handoff is reliable.
const ASK_HERMES_ENABLED = false;
export async function insertPrompt(prompt: string) {
 let reason: string;
 try {
   const result = await handoffPrompt(host, prompt);
   if (result === "inserted") return;
   reason = result === "unavailable" ? "This Hermes version cannot add text to chat." : "The chat input is unavailable.";
 } catch {
   reason = "Hermes could not add the text to chat.";
 }
 try {
   await writeClipboardText(prompt);
   host.notify({ kind: "info", message: `${reason} ${L.copied}` });
 } catch {
   host.notify({ kind: "error", message: `${reason} Copying the text also failed. Please try again.` });
 }
}
export function AskChips({ edit = false, sceneId, selectedIds = [] }: { edit?: boolean; sceneId?: string; selectedIds?: string[] }) {
 if (!ASK_HERMES_ENABLED) return null;
 const chips = <div className={edit ? "p3d-ask-chips p3d-glass" : "p3d-ask-chips"}>{!edit && <>{L.ask} </>}{(edit ? EDIT_PROMPTS : CREATE_PROMPTS).map(prompt => <button className="p3d-btn p3d-btn--sm" key={prompt} disabled={edit && prompt === EDIT_PROMPTS[1] && selectedIds.length === 0} onClick={() => void insertPrompt(sceneId ? `In Plastis3D scene ${sceneId}${selectedIds.length ? `, selected node ids ${selectedIds.join(", ")}` : ""}: ${prompt}` : prompt)}>{prompt}</button>)}</div>;
 // In the editor the prompts live behind one small "Ask Hermes" pill instead of floating over the tools.
 return edit ? <details className="p3d-ask"><summary className="p3d-glass">Ask Hermes ▾</summary>{chips}</details> : chips;
}
export function Checklist() {
 const help = useLearning();
 useEffect(() => { if (help.steps.length !== 5) return; const timer = setTimeout(() => setHelp({ hidden: true }), 4000); return () => clearTimeout(timer); }, [help.steps.length]);
 if (help.hidden) return null;
 return <aside className="p3d-glass p3d-learning" aria-label={L.heading}><button className="p3d-btn p3d-btn--sm" onClick={() => setHelp({ collapsed: !help.collapsed })}>{help.steps.length}/5 {L.heading}</button><button className="p3d-btn p3d-btn--sm" onClick={() => setHelp({ hidden: true })}>{L.hide}</button>{!help.collapsed && (help.steps.length === 5 ? <p>{L.complete}</p> : <ul>{L.steps.map(([id,label]) => <li key={id}>{help.steps.includes(id) ? '✓ ' : '○ '}{label}</li>)}</ul>)}</aside>;
}
export function ShortcutSheet() {
 const [open, setOpen] = useState(false);
 const root = useRef<HTMLDivElement>(null);
 useEffect(() => { const fn = (event: KeyboardEvent) => { const target = event.target as HTMLElement; if (!target.closest('[data-plastis-root]') || target.closest('input,textarea,select,[contenteditable=true]')) return; if (event.key === '?') { event.preventDefault(); setOpen(value => !value); } if (event.key === 'Escape') setOpen(false); }; const target = root.current?.closest('[data-plastis-root]'); target?.addEventListener('keydown', fn as EventListener); return () => target?.removeEventListener('keydown', fn as EventListener); }, []);
 return <div ref={root} className="p3d-shortcut-help"><button className="p3d-btn p3d-btn--sm" aria-label={L.shortcuts} onClick={() => setOpen(!open)}>?</button>{open && <section role="dialog" aria-label={L.shortcuts} className="p3d-glass"><KeyboardTable /><button className="p3d-btn p3d-btn--sm" onClick={() => setOpen(false)}>{L.close}</button></section>}</div>;
}
export { markLearning };
export function CoachTip({ id, text, active }: { id: string; text: string; active: boolean }) {
 const help = useLearning();
 const queued = help.pending[0];
 const tips: Record<string,string> = L.tips;
 const shownId = queued ?? id;
 const shownText = queued ? tips[queued] : text;
 const visible = Boolean(shownText) && active && help.showTips && !help.tips.includes(shownId);
 // A tip is a hint, not a chore: it goes away by itself after a few seconds.
 useEffect(() => { if (!visible) return; const timer = setTimeout(() => importSeen(shownId), 7000); return () => clearTimeout(timer); }, [visible, shownId]);
 if (!visible) return null;
 return <aside className="p3d-coach p3d-glass" role="note">{shownText}<button className="p3d-btn p3d-btn--sm" onClick={() => { importSeen(shownId); }}>{L.dismiss}</button></aside>;
}

export function KeyboardTable() {
 return <>{[[L.tools,L.toolKeys],[L.view,L.viewKeys],[L.edit,L.editKeys],[L.mesh,L.meshKeys]].map(([heading,entries]) => <section key={heading}><h3>{heading}</h3>{entries.split(" · ").map(entry => { const space = entry.indexOf(" "); return <div key={entry}><KbdGroup keys={entry.slice(0,space).split("+")} /> {entry.slice(space+1)}</div>; })}</section>)}</>;
}
