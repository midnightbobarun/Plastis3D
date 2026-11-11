export function cardSceneId(attrs: Readonly<Record<string, string>>): string | null {
  if (!Object.prototype.hasOwnProperty.call(attrs, "scene")) return null;
  const value = attrs.scene;
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) ? value : null;
}
