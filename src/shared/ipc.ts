import type { PetManifest } from './petPackage'
import type { PetEvent } from './petBrain'

export const IPC = {
  GET_PET: 'pet:get',
  MOVE_WINDOW: 'window:move',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  GET_WINDOW_BOUNDS: 'window:get-bounds',
  QUIT: 'app:quit'
} as const

export interface LoadedPet {
  manifest: PetManifest
  spritesheetDataUrl: string
}

export interface MoveDelta { dx: number; dy: number }

export interface Bounds { x: number; y: number; width: number; height: number }
export interface WindowBounds { workArea: Bounds; window: Bounds }

export interface PetApi {
  getPet(): Promise<LoadedPet>
  moveWindow(delta: MoveDelta): void
  setIgnoreMouseEvents(ignore: boolean): void
  getWindowBounds(): Promise<WindowBounds>
  quit(): void
}

declare global {
  interface Window { petApi: PetApi }
}

export type { PetEvent }
