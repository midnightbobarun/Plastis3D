import { setViewPrefs, useViewPrefs } from "../state/viewPrefs";
export function SnapControls() {
 const prefs = useViewPrefs();
 return <details className="p3d-snap p3d-glass"><summary>Snap</summary><div className="p3d-snap-options"><label><input className="p3d-input" type="checkbox" checked={prefs.snap} onChange={e=>setViewPrefs({ snap:e.target.checked })} />Enable snapping</label>{([['snapMove','Move (m)'],['snapRotate','Rotate (°)'],['snapScale','Scale']] as const).map(([key,label])=><label key={key}>{label}<input className="p3d-input" aria-label={label} type="number" min="0.01" max="100" step="0.1" value={prefs[key]} onChange={e=>setViewPrefs({[key]:Number(e.target.value)})}/></label>)}</div></details>;
}
