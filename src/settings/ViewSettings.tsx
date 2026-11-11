import { ListRow, ToggleRow } from "@hermes/plugin-sdk";
import { KeyboardTable } from "../ui/Learning";
import { setHelp, useLearning } from "../state/learning";
import { COPY } from "../copy";
import { setViewPrefs, useViewPrefs } from "../state/viewPrefs";

export function ViewSettings() {
  const prefs = useViewPrefs();
  const help = useLearning();
  return <section className="p3d-root" style={{ padding: 24 }}>
    <h2>View</h2>
    <ListRow title="Background" action={<select aria-label="Background" value={prefs.background} onChange={event => setViewPrefs({ background: event.target.value as typeof prefs.background })}>{["gradient", "studio", "plain"].map(value => <option key={value}>{value}</option>)}</select>} />
    <ListRow title="Tone" action={<select aria-label="Tone" value={prefs.toneMapping} onChange={event => setViewPrefs({ toneMapping: event.target.value as typeof prefs.toneMapping })}>{["neutral", "aces", "none"].map(value => <option key={value}>{value}</option>)}</select>} />
    <ListRow title="Quality" action={<select aria-label="Quality" value={prefs.quality} onChange={event => setViewPrefs({ quality: event.target.value as typeof prefs.quality })}>{["auto", "high", "low"].map(value => <option key={value}>{value}</option>)}</select>} />
    {(["grid", "showHelpers", "fillLight"] as const).map(key => <ToggleRow key={key} label={key === "grid" ? "Grid" : key === "showHelpers" ? "Helpers" : "Fill light"} checked={prefs[key]} onChange={checked => setViewPrefs({ [key]: checked })} />)}
    <ListRow title="Grid size (m)" action={<input aria-label="Grid size (m)" type="number" min="0.1" max="100" step="0.1" value={prefs.gridSize} onChange={event => setViewPrefs({ gridSize: Number(event.target.value) })} />} />
    <h2>Help</h2>
    <ToggleRow label="Show tips" checked={help.showTips} onChange={checked => setHelp({ showTips: checked })} />
    <ListRow title="Getting started" action={<button className="p3d-btn" onClick={() => setHelp({ hidden: false, steps: [] })}>Show getting-started checklist</button>} />
    <ListRow title="Coach tips" action={<button className="p3d-btn" onClick={() => setHelp({ tips: [] })}>Reset tips</button>} />
    <h2>Keyboard shortcuts</h2><KeyboardTable /><p>{COPY.viewOnly}</p>
  </section>;
}
