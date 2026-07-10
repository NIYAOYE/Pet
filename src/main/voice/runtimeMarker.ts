export const VOICE_RUNTIME_MARKER_VERSION = 1

export interface RuntimeMarker {
  markerVersion: number
  gsvTtsLiteVersion: string
  device: 'cuda' | 'cpu'
}

export function parseRuntimeMarker(raw: string): RuntimeMarker | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j.markerVersion !== 'number' || typeof j.gsvTtsLiteVersion !== 'string') return null
    if (j.device !== 'cuda' && j.device !== 'cpu') return null
    return { markerVersion: j.markerVersion, gsvTtsLiteVersion: j.gsvTtsLiteVersion, device: j.device }
  } catch {
    return null
  }
}

export function isRuntimeUsable(marker: RuntimeMarker | null): boolean {
  return marker !== null && marker.markerVersion === VOICE_RUNTIME_MARKER_VERSION
}

export function serializeRuntimeMarker(m: RuntimeMarker): string {
  return JSON.stringify(m, null, 2)
}
