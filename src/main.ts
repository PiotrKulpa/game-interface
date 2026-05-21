import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import type {
  AddGameResult,
  Game,
  GameLibraryEntry,
  LaunchGameResult,
  RawgGameMetadata,
  RemoveGameResult,
} from './game-types';

const GAME_LIBRARY_FILE_NAME = 'games.json';
const GAME_EXECUTABLE_EXTENSIONS = ['exe', 'app', 'bat', 'cmd', 'sh'];
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 760;
const RAWG_API_BASE_URL = 'https://api.rawg.io/api';
const RAWG_API_KEY_VARIABLE = 'RAWG_API_KEY';
const RAWG_API_KEY_ALIAS_VARIABLE = 'RAWG_API_KEY_ENV';
const RAWG_PAGE_SIZE = 5;
const RAWG_MAX_QUERY_LENGTH = 80;
const RAWG_REQUEST_TIMEOUT_MS = 6000;
const RAWG_DESCRIPTION_MAX_LENGTH = 1800;
const RAWG_QUERY_CANDIDATE_LIMIT = 5;
const ENV_FILE_NAME = '.env';
const SRC_DIRECTORY_NAME = 'src';
const EXECUTABLE_NAME_NOISE_TOKENS = new Set<string>([
  'x86',
  'x64',
  'win32',
  'win64',
  'windows',
  'linux',
  'mac',
  'macos',
  'launcher',
  'shipping',
  'release',
  'final',
  'setup',
  'install',
  'uninstall',
  'portable',
  'demo',
  'beta',
  'alpha',
  'build',
  'client',
]);

const rawgLookupCache = new Map<string, RawgGameMetadata | null>();
type RawgGameDetails = {
  readonly description: string | null;
  readonly backgroundAdditionalImageUrl: string | null;
};

const rawgDetailsCache = new Map<number, RawgGameDetails>();
let envFileCache: Readonly<Record<string, string>> | undefined;

const getGameLibraryPath = (): string =>
  path.join(app.getPath('userData'), GAME_LIBRARY_FILE_NAME);

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Nieznany blad.';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseEnvFileContent = (value: string): Readonly<Record<string, string>> => {
  const parsedValues: Record<string, string> = {};
  const lines = value.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ')
      ? line.slice('export '.length)
      : line;
    const equalsIndex = normalizedLine.indexOf('=');
    if (equalsIndex < 1) {
      continue;
    }

    const key = normalizedLine.slice(0, equalsIndex).trim();
    const rawValue = normalizedLine.slice(equalsIndex + 1).trim();
    if (key.length === 0 || rawValue.length === 0) {
      continue;
    }

    const isDoubleQuoted =
      rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2;
    const isSingleQuoted =
      rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2;

    parsedValues[key] =
      isDoubleQuoted || isSingleQuoted ? rawValue.slice(1, -1) : rawValue;
  }

  return parsedValues;
};

const getEnvFileValues = (): Readonly<Record<string, string>> => {
  if (envFileCache !== undefined) {
    return envFileCache;
  }

  const candidatePaths = [
    path.join(process.cwd(), ENV_FILE_NAME),
    path.join(process.cwd(), SRC_DIRECTORY_NAME, ENV_FILE_NAME),
    path.join(app.getAppPath(), ENV_FILE_NAME),
    path.join(app.getAppPath(), SRC_DIRECTORY_NAME, ENV_FILE_NAME),
  ];

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    try {
      const fileContent = readFileSync(candidatePath, 'utf8');
      envFileCache = parseEnvFileContent(fileContent);
      return envFileCache;
    } catch {
      // Keep looking through remaining locations.
    }
  }

  envFileCache = {};
  return envFileCache;
};

const getConfigValue = (key: string): string | null => {
  const processValue = process.env[key];
  if (typeof processValue === 'string' && processValue.trim().length > 0) {
    return processValue.trim();
  }

  const envFileValue = getEnvFileValues()[key];
  if (typeof envFileValue === 'string' && envFileValue.trim().length > 0) {
    return envFileValue.trim();
  }

  return null;
};

const getRawgApiKey = (): string | null => {
  const directKey = getConfigValue(RAWG_API_KEY_VARIABLE);
  if (directKey) {
    return directKey;
  }

  const aliasValue = getConfigValue(RAWG_API_KEY_ALIAS_VARIABLE);
  if (!aliasValue) {
    return null;
  }

  const looksLikeVariableName = /^[A-Z_][A-Z0-9_]*$/.test(aliasValue);
  if (looksLikeVariableName) {
    const referencedValue = getConfigValue(aliasValue);
    if (referencedValue) {
      return referencedValue;
    }

    // Guard against accidental config like RAWG_API_KEY_ENV=RAWG_API_KEY
    if (
      aliasValue === RAWG_API_KEY_VARIABLE ||
      aliasValue === RAWG_API_KEY_ALIAS_VARIABLE
    ) {
      return null;
    }

    // Short uppercase tokens are usually variable names, not API keys.
    if (aliasValue.length <= 24) {
      return null;
    }
  }

  return aliasValue;
};

const toNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const toNullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const sanitizeRawgDescription = (value: string): string => {
  const withoutHtml = value.replace(/<[^>]*>/g, ' ');
  const normalizedSpacing = withoutHtml.replace(/\s+/g, ' ').trim();

  if (normalizedSpacing.length <= RAWG_DESCRIPTION_MAX_LENGTH) {
    return normalizedSpacing;
  }

  return `${normalizedSpacing.slice(0, RAWG_DESCRIPTION_MAX_LENGTH).trimEnd()}...`;
};

const normalizeGameSearchName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '');

const normalizeGameDisplayName = (value: string): string =>
  value.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();

const stripBracketTags = (value: string): string =>
  value.replace(/\[[^\]]*]|\([^)]*\)|\{[^}]*\}/g, ' ');

const stripNoiseTokens = (value: string): string => {
  const tokens = value.split(/\s+/).filter(Boolean);
  const filteredTokens = tokens.filter(
    (token) => !EXECUTABLE_NAME_NOISE_TOKENS.has(token.toLowerCase()),
  );

  return filteredTokens.join(' ');
};

const deduplicateNameCandidates = (
  candidates: readonly string[],
): readonly string[] => {
  const normalizedCandidates = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const trimmedCandidate = candidate.trim();
    if (trimmedCandidate.length === 0) {
      continue;
    }

    const normalizedCandidate = normalizeGameSearchName(trimmedCandidate);
    if (
      normalizedCandidate.length === 0 ||
      normalizedCandidates.has(normalizedCandidate)
    ) {
      continue;
    }

    normalizedCandidates.add(normalizedCandidate);
    result.push(trimmedCandidate);

    if (result.length >= RAWG_QUERY_CANDIDATE_LIMIT) {
      break;
    }
  }

  return result;
};

const toSearchFriendlyGameName = (value: string): string =>
  normalizeGameDisplayName(stripNoiseTokens(stripBracketTags(value)));

const getGameNameCandidates = (executablePath: string): readonly string[] => {
  const extension = path.extname(executablePath);
  const executableBaseName = path.basename(executablePath, extension);
  const installDirectoryName = path.basename(path.dirname(executablePath));

  const normalizedExecutableBaseName = normalizeGameDisplayName(executableBaseName);
  const normalizedInstallDirectoryName =
    normalizeGameDisplayName(installDirectoryName);

  return deduplicateNameCandidates([
    toSearchFriendlyGameName(normalizedExecutableBaseName),
    normalizedExecutableBaseName,
    toSearchFriendlyGameName(normalizedInstallDirectoryName),
    normalizedInstallDirectoryName,
  ]);
};

const toRawgGameMetadata = (value: unknown): RawgGameMetadata | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'number' ||
    typeof value.slug !== 'string' ||
    typeof value.name !== 'string'
  ) {
    return null;
  }

  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    backgroundImageUrl: toNullableString(value.background_image),
    backgroundAdditionalImageUrl: undefined,
    released: toNullableString(value.released),
    rating: toNullableNumber(value.rating),
    description: undefined,
  };
};

const fetchRawgGameDetails = async (
  gameId: number,
): Promise<RawgGameDetails> => {
  const cachedDetails = rawgDetailsCache.get(gameId);
  if (cachedDetails) {
    return cachedDetails;
  }

  const rawgApiKey = getRawgApiKey();
  if (!rawgApiKey) {
    return {
      description: null,
      backgroundAdditionalImageUrl: null,
    };
  }

  const requestUrl = `${RAWG_API_BASE_URL}/games/${gameId}?key=${encodeURIComponent(rawgApiKey)}`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    RAWG_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      const emptyDetails: RawgGameDetails = {
        description: null,
        backgroundAdditionalImageUrl: null,
      };
      rawgDetailsCache.set(gameId, emptyDetails);
      return emptyDetails;
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      const emptyDetails: RawgGameDetails = {
        description: null,
        backgroundAdditionalImageUrl: null,
      };
      rawgDetailsCache.set(gameId, emptyDetails);
      return emptyDetails;
    }

    const rawDescription =
      toNullableString(payload.description_raw) ?? toNullableString(payload.description);
    const description = rawDescription
      ? sanitizeRawgDescription(rawDescription)
      : null;

    const details: RawgGameDetails = {
      description: description && description.length > 0 ? description : null,
      backgroundAdditionalImageUrl: toNullableString(
        payload.background_image_additional,
      ),
    };

    rawgDetailsCache.set(gameId, details);
    return details;
  } catch {
    return {
      description: null,
      backgroundAdditionalImageUrl: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const withRawgDetails = async (
  metadata: RawgGameMetadata,
): Promise<RawgGameMetadata> => {
  if (
    metadata.description !== undefined &&
    metadata.backgroundAdditionalImageUrl !== undefined
  ) {
    return metadata;
  }

  const details = await fetchRawgGameDetails(metadata.id);
  return {
    ...metadata,
    description: details.description,
    backgroundAdditionalImageUrl: details.backgroundAdditionalImageUrl,
  };
};

const pickBestRawgGame = (
  query: string,
  candidates: readonly RawgGameMetadata[],
): RawgGameMetadata => {
  const normalizedQuery = normalizeGameSearchName(query);
  const exactMatch = candidates.find(
    (candidate) => normalizeGameSearchName(candidate.name) === normalizedQuery,
  );

  if (exactMatch) {
    return exactMatch;
  }

  const prefixMatch = candidates.find((candidate) =>
    normalizeGameSearchName(candidate.name).startsWith(normalizedQuery),
  );

  return prefixMatch ?? candidates[0];
};

const fetchRawgGameMetadata = async (
  query: string,
): Promise<RawgGameMetadata | null> => {
  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeGameSearchName(trimmedQuery);
  if (normalizedQuery.length === 0) {
    return null;
  }

  const cachedResult = rawgLookupCache.get(normalizedQuery);
  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const rawgApiKey = getRawgApiKey();
  if (!rawgApiKey) {
    rawgLookupCache.set(normalizedQuery, null);
    return null;
  }

  const params = new URLSearchParams({
    key: rawgApiKey,
    search: trimmedQuery.slice(0, RAWG_MAX_QUERY_LENGTH),
    search_precise: 'true',
    page_size: String(RAWG_PAGE_SIZE),
  });

  const requestUrl = `${RAWG_API_BASE_URL}/games?${params.toString()}`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    RAWG_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      rawgLookupCache.set(normalizedQuery, null);
      return null;
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      rawgLookupCache.set(normalizedQuery, null);
      return null;
    }

    const candidates: RawgGameMetadata[] = payload.results
      .map((entry) => toRawgGameMetadata(entry))
      .filter((entry): entry is RawgGameMetadata => entry !== null);

    if (candidates.length === 0) {
      rawgLookupCache.set(normalizedQuery, null);
      return null;
    }

    const metadata = pickBestRawgGame(trimmedQuery, candidates);
    const metadataWithDescription = await withRawgDetails(metadata);
    rawgLookupCache.set(normalizedQuery, metadataWithDescription);
    return metadataWithDescription;
  } catch {
    rawgLookupCache.set(normalizedQuery, null);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

const fetchRawgGameMetadataForQueries = async (
  queries: readonly string[],
): Promise<RawgGameMetadata | null> => {
  for (const query of queries) {
    const metadata = await fetchRawgGameMetadata(query);
    if (metadata) {
      return metadata;
    }
  }

  return null;
};

const getRawgQueryCandidatesForGame = (
  game: GameLibraryEntry,
): readonly string[] =>
  deduplicateNameCandidates([game.name, ...getGameNameCandidates(game.executablePath)]);

const enrichGameWithRawgMetadata = async (
  game: GameLibraryEntry,
): Promise<Game> => {
  const rawgMetadata = await fetchRawgGameMetadataForQueries(
    getRawgQueryCandidatesForGame(game),
  );
  if (!rawgMetadata) {
    return game;
  }

  return {
    ...game,
    name: rawgMetadata.name,
    rawg: rawgMetadata,
  };
};

const enrichGamesMetadata = async (
  games: readonly GameLibraryEntry[],
): Promise<readonly Game[]> => {
  if (!getRawgApiKey()) {
    return games;
  }

  return Promise.all(games.map((game) => enrichGameWithRawgMetadata(game)));
};

const toGameLibraryEntry = (value: unknown): GameLibraryEntry | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.executablePath !== 'string' ||
    typeof value.installDirectory !== 'string' ||
    typeof value.addedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    executablePath: value.executablePath,
    installDirectory: value.installDirectory,
    addedAt: value.addedAt,
  };
};

const readGames = async (): Promise<readonly GameLibraryEntry[]> => {
  try {
    const fileContent = await fs.readFile(getGameLibraryPath(), 'utf8');
    const parsedContent: unknown = JSON.parse(fileContent);

    if (!Array.isArray(parsedContent)) {
      return [];
    }

    return parsedContent
      .map((entry) => toGameLibraryEntry(entry))
      .filter((entry): entry is GameLibraryEntry => entry !== null);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const writeGames = async (games: readonly GameLibraryEntry[]): Promise<void> => {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getGameLibraryPath(), JSON.stringify(games, null, 2));
};

const getGameName = (executablePath: string): string =>
  getGameNameCandidates(executablePath)[0] ?? path.basename(executablePath);

const launchExecutable = (game: GameLibraryEntry): Promise<LaunchGameResult> =>
  new Promise((resolve) => {
    const childProcess = spawn(game.executablePath, [], {
      cwd: game.installDirectory,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    childProcess.once('error', (error: Error) => {
      resolve({ status: 'failed', message: error.message });
    });

    childProcess.once('spawn', () => {
      childProcess.unref();
      resolve({ status: 'launched' });
    });
  });

const registerGameHandlers = (): void => {
  ipcMain.handle('games:list', async (): Promise<readonly Game[]> => {
    const games = await readGames();
    await writeGames(games);
    return enrichGamesMetadata(games);
  });

  ipcMain.handle('games:add', async (): Promise<AddGameResult> => {
    const selection = await dialog.showOpenDialog({
      title: 'Wybierz plik uruchamiajacy gre',
      buttonLabel: 'Dodaj gre',
      properties: ['openFile'],
      filters: [
        {
          name: 'Pliki uruchamiajace',
          extensions: GAME_EXECUTABLE_EXTENSIONS,
        },
        { name: 'Wszystkie pliki', extensions: ['*'] },
      ],
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const executablePath = selection.filePaths[0];
    const games = await readGames();
    const existingGame = games.find(
      (game) => game.executablePath === executablePath,
    );

    if (existingGame) {
      const enrichedExistingGame = await enrichGameWithRawgMetadata(existingGame);
      return { status: 'existing', game: enrichedExistingGame };
    }

    const baseGame: GameLibraryEntry = {
      id: randomUUID(),
      name: getGameName(executablePath),
      executablePath,
      installDirectory: path.dirname(executablePath),
      addedAt: new Date().toISOString(),
    };

    const game = await enrichGameWithRawgMetadata(baseGame);
    await writeGames([...games, baseGame]);

    return { status: 'added', game };
  });

  ipcMain.handle(
    'games:launch',
    async (_event, gameId: unknown): Promise<LaunchGameResult> => {
      if (typeof gameId !== 'string') {
        return { status: 'failed', message: 'Niepoprawne ID gry.' };
      }

      const games = await readGames();
      const game = games.find((item) => item.id === gameId);

      if (!game) {
        return { status: 'failed', message: 'Nie znaleziono gry.' };
      }

      try {
        await fs.access(game.executablePath);

        if (
          process.platform === 'darwin' &&
          path.extname(game.executablePath).toLowerCase() === '.app'
        ) {
          const message = await shell.openPath(game.executablePath);

          if (message) {
            return { status: 'failed', message };
          }

          return { status: 'launched' };
        }

        return await launchExecutable(game);
      } catch (error: unknown) {
        return { status: 'failed', message: getErrorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    'games:remove',
    async (_event, gameId: unknown): Promise<RemoveGameResult> => {
      if (typeof gameId !== 'string') {
        return { status: 'missing' };
      }

      const games = await readGames();
      const filteredGames = games.filter((game) => game.id !== gameId);

      if (filteredGames.length === games.length) {
        return { status: 'missing' };
      }

      await writeGames(filteredGames);

      return { status: 'removed' };
    },
  );
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#101319',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.setFullScreen(true);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

const shouldEnableAutoLaunch = (): boolean =>
  app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');

const configureAutoLaunch = (): void => {
  if (!shouldEnableAutoLaunch()) {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: true,
  });
};

registerGameHandlers();

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  configureAutoLaunch();
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
