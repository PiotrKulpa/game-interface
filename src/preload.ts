import { contextBridge, ipcRenderer } from 'electron';
import type {
  AddGameResult,
  Game,
  GameLauncherApi,
  LaunchGameResult,
  RemoveGameResult,
} from './game-types';

const gameLauncherApi: GameLauncherApi = {
  listGames: (): Promise<readonly Game[]> => ipcRenderer.invoke('games:list'),
  addGame: (): Promise<AddGameResult> => ipcRenderer.invoke('games:add'),
  launchGame: (gameId: string): Promise<LaunchGameResult> =>
    ipcRenderer.invoke('games:launch', gameId),
  removeGame: (gameId: string): Promise<RemoveGameResult> =>
    ipcRenderer.invoke('games:remove', gameId),
};

contextBridge.exposeInMainWorld('gameLauncher', gameLauncherApi);
