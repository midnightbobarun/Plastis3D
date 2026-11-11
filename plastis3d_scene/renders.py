"""Latest render PNG per scene; no scene revision or undo mutation."""
from .capture import png_dimensions
from .spec import PlastisError
from .store import Store, _SceneLock

def save_render(store, scene_id, revision, data):
    store.get_scene(scene_id)
    if not isinstance(revision, int) or isinstance(revision, bool):
        raise PlastisError('SPEC_INVALID', 'revision must be an integer')
    if len(data) > 16 * 1024 * 1024:
        raise PlastisError('RENDER_TOO_LARGE', 'Render exceeds 16 MiB')
    width, height = png_dimensions(data)
    if max(width, height) > 2048:
        raise PlastisError('RENDER_TOO_LARGE', 'Render exceeds 2048 pixels')
    with _SceneLock(store.lock_path(scene_id)):
        scene = store.get_scene(scene_id)
        if revision != scene['revision']:
            raise PlastisError('REVISION_CONFLICT', 'Scene changed before render was saved')
        path = store.data_dir / 'renders' / (scene_id + '.png')
        path.parent.mkdir(parents=True, exist_ok=True)
        Store._atomic_write(path, data)
    return dict(ok=True, path=str(path), bytes=len(data), filename=scene_id+'.png')
