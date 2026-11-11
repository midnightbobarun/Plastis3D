interface Entry { element: Element; height: number; notify: (selected: boolean) => void }
const entries = new Map<string, Entry>();
let winner: string | null = null;
export function reportCard(id: string, entry: Entry | null): void {
  const old = winner;
  const previous = old ? entries.get(old) : undefined;
  if (entry) entries.set(id, entry); else entries.delete(id);
  let best = winner ? entries.get(winner) : undefined;
  if (!best || best.height <= 0) { winner = null; best = undefined; }
  for (const [key, value] of entries) {
    if (value.height <= 0) continue;
    if (!best || value.height > best.height || (winner !== old && value.height === best.height && Boolean(best.element.compareDocumentPosition(value.element) & 4))) {
      best = value; winner = key;
    }
  }
  if (old !== winner) { previous?.notify(false); if (winner) entries.get(winner)?.notify(true); }
}
