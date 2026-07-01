import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PetApi, type LoadedPet, type MoveDelta, type WindowBounds } from '@shared/ipc'

const api: PetApi = {
  getPet: (): Promise<LoadedPet> => ipcRenderer.invoke(IPC.GET_PET),
  moveWindow: (delta: MoveDelta): void => ipcRenderer.send(IPC.MOVE_WINDOW, delta),
  setIgnoreMouseEvents: (ignore: boolean): void => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  getWindowBounds: (): Promise<WindowBounds> => ipcRenderer.invoke(IPC.GET_WINDOW_BOUNDS),
  quit: (): void => ipcRenderer.send(IPC.QUIT)
}

contextBridge.exposeInMainWorld('petApi', api)
