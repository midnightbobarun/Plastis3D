/** Capture one chat address; never retarget a pending draft after navigation. */
export interface ComposerHost {
  composer?: { insertText(id: string | null, text: string, options: { mode: "block" }): Promise<boolean> };
  state: {
    focusedSessionId?: { get(): unknown };
    focusedStoredSessionId?: { get(): unknown };
    focusedSessionProfile?: { get(): unknown };
  };
  openSession?: (id: string, options: { profile?: string; intent: "in-place" }) => unknown;
}

export async function handoffPrompt(host: ComposerHost, text: string, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<"inserted" | "unavailable" | "no-composer"> {
  if (!host.composer?.insertText) return "unavailable";
  const runtime = host.state.focusedSessionId?.get();
  const stored = host.state.focusedStoredSessionId?.get();
  const profile = host.state.focusedSessionProfile?.get();
  const address = typeof stored === "string" && stored ? stored : typeof runtime === "string" && runtime ? runtime : null;
  if (await host.composer.insertText(address, text, { mode: "block" })) return "inserted";
  if (typeof stored !== "string" || !stored || !host.openSession) return "no-composer";
  await host.openSession(stored, { intent: "in-place", ...(typeof profile === "string" ? { profile } : {}) });
  // Navigation mounts the chat asynchronously. Retry only unacknowledged writes.
  for (let attempt = 0; attempt < 10; attempt++) {
    await wait(150);
    if (await host.composer.insertText(address, text, { mode: "block" })) return "inserted";
  }
  return "no-composer";
}
