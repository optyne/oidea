import type { BridgeInit } from './bridge';

const headers = (init: BridgeInit) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${init.token}`,
});

export async function getPage(init: BridgeInit): Promise<{ format: string; drawing: string | null }> {
  const res = await fetch(`${init.apiBase}/whiteboard/${init.boardId}/pages/${init.pageId}`, {
    headers: headers(init),
  });
  if (!res.ok) throw new Error(`getPage ${res.status}`);
  return res.json();
}

export async function savePage(
  init: BridgeInit,
  drawingBase64: string,
  thumbnailBase64?: string,
): Promise<void> {
  const res = await fetch(`${init.apiBase}/whiteboard/${init.boardId}/pages/${init.pageId}`, {
    method: 'PUT',
    headers: headers(init),
    body: JSON.stringify({
      drawing: drawingBase64,
      ...(thumbnailBase64 ? { thumbnail: thumbnailBase64 } : {}),
    }),
  });
  if (!res.ok) throw new Error(`savePage ${res.status}`);
}
