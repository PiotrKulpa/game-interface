import './index.css';
import type { Game, GameLauncherApi, LaunchGameResult } from './game-types';

declare global {
  interface Window {
    readonly gameLauncher: GameLauncherApi;
  }
}

type StatusTone = 'neutral' | 'success' | 'error';
type Direction = 'up' | 'down' | 'left' | 'right';
type ViewMode = 'library' | 'details';

const GAMEPAD_DEADZONE = 0.55;
const GAMEPAD_FIRST_REPEAT_DELAY_MS = 260;
const GAMEPAD_REPEAT_DELAY_MS = 120;
const GAMEPAD_BUTTON_A = 0;
const GAMEPAD_BUTTON_B = 1;
const GAMEPAD_BUTTON_X = 2;
const GAMEPAD_DPAD_UP = 12;
const GAMEPAD_DPAD_DOWN = 13;
const GAMEPAD_DPAD_LEFT = 14;
const GAMEPAD_DPAD_RIGHT = 15;

const appElement = document.querySelector<HTMLDivElement>('#app');

if (!appElement) {
  throw new Error('Brakuje elementu #app.');
}

appElement.innerHTML = `
  <main class="launcher-shell" data-view="library" id="launcher-shell">
    <header class="launcher-header">
      <div>
        <p class="eyebrow">Game Interface</p>
        <h1>Biblioteka gier</h1>
      </div>
      <div class="header-actions" role="group" aria-label="Akcje biblioteki">
        <button class="primary-action" id="add-game-button" type="button">
          <span aria-hidden="true">+</span>
          Dodaj gre
        </button>
      </div>
    </header>

    <section class="toolbar" aria-live="polite">
      <p id="game-counter">0 gier</p>
      <p class="status-message" data-tone="neutral" id="status-message">
        Biblioteka gotowa.
      </p>
    </section>

    <section class="library-view" id="library-view" aria-label="Biblioteka">
      <section class="empty-state" id="empty-state">
        <h2>Biblioteka jest pusta</h2>
        <p>Brak dodanych gier.</p>
      </section>
      <section class="game-grid" id="game-grid" aria-label="Lista gier"></section>
    </section>

    <section class="details-view" id="details-view" aria-label="Szczegoly gry" hidden>
      <button class="ghost-action" id="details-back-button" type="button">
        <span aria-hidden="true">&lt;</span>
        Powrot do biblioteki
      </button>

      <article class="details-card" id="details-card">
        <div class="details-cover" id="details-cover" aria-hidden="true"></div>
        <div class="details-body">
          <h2 id="details-title">Brak wybranej gry</h2>
          <p class="details-meta" id="details-meta">Wybierz kafelek w bibliotece.</p>
          <p class="details-description" id="details-description">Opis gry pojawi sie tutaj.</p>
          <p class="details-path" id="details-path"></p>
          <div class="details-actions" role="group" aria-label="Akcje gry">
            <button class="primary-action details-launch" id="details-launch-button" type="button">
              <span aria-hidden="true">&gt;</span>
              Uruchom gre
            </button>
            <button class="secondary-action details-remove" id="details-remove-button" type="button">
              <span aria-hidden="true">-</span>
              Usun z biblioteki
            </button>
          </div>
        </div>
      </article>
    </section>
  </main>
`;

const launcherShell = document.querySelector<HTMLElement>('#launcher-shell');
const addGameButton = document.querySelector<HTMLButtonElement>('#add-game-button');
const gameGrid = document.querySelector<HTMLElement>('#game-grid');
const emptyState = document.querySelector<HTMLElement>('#empty-state');
const statusMessage = document.querySelector<HTMLElement>('#status-message');
const gameCounter = document.querySelector<HTMLElement>('#game-counter');
const libraryView = document.querySelector<HTMLElement>('#library-view');
const detailsView = document.querySelector<HTMLElement>('#details-view');
const detailsBackButton = document.querySelector<HTMLButtonElement>('#details-back-button');
const detailsLaunchButton = document.querySelector<HTMLButtonElement>('#details-launch-button');
const detailsRemoveButton = document.querySelector<HTMLButtonElement>('#details-remove-button');
const detailsCover = document.querySelector<HTMLElement>('#details-cover');
const detailsTitle = document.querySelector<HTMLElement>('#details-title');
const detailsMeta = document.querySelector<HTMLElement>('#details-meta');
const detailsDescription = document.querySelector<HTMLElement>('#details-description');
const detailsPath = document.querySelector<HTMLElement>('#details-path');

if (
  !launcherShell ||
  !addGameButton ||
  !gameGrid ||
  !emptyState ||
  !statusMessage ||
  !gameCounter ||
  !libraryView ||
  !detailsView ||
  !detailsBackButton ||
  !detailsLaunchButton ||
  !detailsRemoveButton ||
  !detailsCover ||
  !detailsTitle ||
  !detailsMeta ||
  !detailsDescription ||
  !detailsPath
) {
  throw new Error('Nie udalo sie zainicjalizowac interfejsu.');
}

let games: readonly Game[] = [];
let selectedGameId: string | null = null;
let detailsGameId: string | null = null;
let activeView: ViewMode = 'library';

let gamepadButtonsSnapshot: readonly boolean[] = [];
let heldDirection: Direction | null = null;
let nextDirectionRepeatAt = 0;

const setStatus = (message: string, tone: StatusTone = 'neutral'): void => {
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
};

const getGameCounterLabel = (gameCount: number): string => {
  if (gameCount === 1) {
    return '1 gra';
  }

  if (gameCount > 1 && gameCount < 5) {
    return `${gameCount} gry`;
  }

  return `${gameCount} gier`;
};

const getCssUrl = (url: string): string =>
  encodeURI(url)
    .replace(/"/g, '%22')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');

const getGameMetaLabel = (game: Game): string | null => {
  if (!game.rawg) {
    return null;
  }

  const releaseYear =
    typeof game.rawg.released === 'string' && game.rawg.released.length >= 4
      ? game.rawg.released.slice(0, 4)
      : null;
  const roundedRating =
    typeof game.rawg.rating === 'number' ? game.rawg.rating.toFixed(1) : null;

  if (releaseYear && roundedRating) {
    return `${releaseYear} • RAWG ${roundedRating}/5`;
  }

  if (releaseYear) {
    return releaseYear;
  }

  if (roundedRating) {
    return `RAWG ${roundedRating}/5`;
  }

  return null;
};

const getGameDescription = (game: Game): string => {
  const description = game.rawg?.description;
  if (typeof description === 'string' && description.trim().length > 0) {
    return description;
  }

  return 'Brak opisu gry w RAWG.';
};

const getGameById = (gameId: string | null): Game | null => {
  if (!gameId) {
    return null;
  }

  const game = games.find((item) => item.id === gameId);
  return game ?? null;
};

const getSelectedGameIndex = (): number =>
  games.findIndex((game) => game.id === selectedGameId);

const getSelectedGame = (): Game | null => {
  const selectedIndex = getSelectedGameIndex();
  if (selectedIndex < 0) {
    return null;
  }

  return games[selectedIndex];
};

const getDetailsGame = (): Game | null => getGameById(detailsGameId);

const getActionGame = (): Game | null => {
  if (activeView === 'details') {
    return getDetailsGame();
  }

  return getSelectedGame();
};

const getGameCards = (): HTMLElement[] =>
  Array.from(gameGrid.querySelectorAll<HTMLElement>('.game-card'));

const getCardsPerRow = (): number => {
  const cards = getGameCards();
  if (cards.length === 0) {
    return 1;
  }

  const firstRowTop = cards[0].offsetTop;
  let cardsPerRow = 0;

  for (const card of cards) {
    if (card.offsetTop !== firstRowTop) {
      break;
    }

    cardsPerRow += 1;
  }

  return Math.max(cardsPerRow, 1);
};

const applySelectionState = (focusSelectedCard: boolean): void => {
  const cards = getGameCards();

  for (const card of cards) {
    const isSelected = card.dataset.gameId === selectedGameId;
    card.tabIndex = isSelected ? 0 : -1;
    card.classList.toggle('is-selected', isSelected);
  }

  if (!focusSelectedCard) {
    return;
  }

  const selectedCard = cards.find((card) => card.dataset.gameId === selectedGameId);
  selectedCard?.focus();
};

const setSelectedGameByIndex = (index: number, focusSelectedCard: boolean): void => {
  if (games.length === 0) {
    selectedGameId = null;
    return;
  }

  const boundedIndex = Math.max(0, Math.min(index, games.length - 1));
  selectedGameId = games[boundedIndex].id;
  applySelectionState(focusSelectedCard);
};

const focusAddButton = (): void => {
  addGameButton.focus();
};

const setView = (view: ViewMode): void => {
  activeView = view;
  launcherShell.dataset.view = view;

  const isLibraryView = view === 'library';
  libraryView.hidden = !isLibraryView;
  detailsView.hidden = isLibraryView;

  libraryView.setAttribute('aria-hidden', String(!isLibraryView));
  detailsView.setAttribute('aria-hidden', String(isLibraryView));
};

const renderDetails = (game: Game): void => {
  detailsTitle.textContent = game.name;
  detailsMeta.textContent = getGameMetaLabel(game) ?? 'Brak danych RAWG dla tej gry.';
  detailsDescription.textContent = getGameDescription(game);
  detailsPath.textContent = game.executablePath;

  const detailsBackgroundImageUrl =
    game.rawg?.backgroundAdditionalImageUrl ?? game.rawg?.backgroundImageUrl;
  if (detailsBackgroundImageUrl) {
    detailsView.classList.add('has-background');
    detailsView.style.backgroundImage = [
      'linear-gradient(180deg, rgba(10, 12, 16, 0.82), rgba(10, 12, 16, 0.9))',
      `url("${getCssUrl(detailsBackgroundImageUrl)}")`,
    ].join(', ');
  } else {
    detailsView.classList.remove('has-background');
    detailsView.style.backgroundImage = '';
  }

  const coverImageUrl = game.rawg?.backgroundImageUrl;
  if (coverImageUrl) {
    detailsCover.classList.add('has-cover');
    detailsCover.style.backgroundImage = [
      'linear-gradient(180deg, rgba(12, 13, 15, 0.18) 6%, rgba(12, 13, 15, 0.84) 95%)',
      `url("${getCssUrl(coverImageUrl)}")`,
    ].join(', ');
  } else {
    detailsCover.classList.remove('has-cover');
    detailsCover.style.backgroundImage = '';
  }
};

const focusDetailsLaunchButton = (): void => {
  if (!detailsLaunchButton.disabled) {
    detailsLaunchButton.focus();
    return;
  }

  if (!detailsRemoveButton.disabled) {
    detailsRemoveButton.focus();
    return;
  }

  detailsBackButton.focus();
};

const enterDetails = (gameId: string, focusLaunchButton = true): void => {
  const game = getGameById(gameId);
  if (!game) {
    return;
  }

  selectedGameId = game.id;
  detailsGameId = game.id;
  renderDetails(game);
  setView('details');
  setStatus(`Szczegoly gry: ${game.name}`);

  if (focusLaunchButton) {
    focusDetailsLaunchButton();
  }
};

const exitDetails = (focusTarget: 'grid' | 'header' = 'grid'): void => {
  setView('library');
  detailsGameId = null;

  if (focusTarget === 'header' || games.length === 0) {
    focusAddButton();
    return;
  }

  applySelectionState(true);
};

const syncSelectionAfterDataChange = (): void => {
  if (games.length === 0) {
    selectedGameId = null;
    return;
  }

  const stillExists = selectedGameId
    ? games.some((game) => game.id === selectedGameId)
    : false;

  if (!stillExists) {
    selectedGameId = games[0].id;
  }
};

const renderGames = (): void => {
  gameGrid.textContent = '';
  emptyState.hidden = games.length > 0;
  gameCounter.textContent = getGameCounterLabel(games.length);

  for (const game of games) {
    gameGrid.append(createGameCard(game));
  }

  applySelectionState(false);
};

const loadGames = async (): Promise<void> => {
  games = await window.gameLauncher.listGames();
  syncSelectionAfterDataChange();
  renderGames();

  if (activeView === 'details') {
    const currentDetailsGame = getDetailsGame();
    if (!currentDetailsGame) {
      exitDetails(games.length > 0 ? 'grid' : 'header');
      return;
    }

    renderDetails(currentDetailsGame);
  }
};

const handleLaunchResult = (gameName: string, result: LaunchGameResult): void => {
  if (result.status === 'launched') {
    setStatus(`Uruchamiam: ${gameName}`, 'success');
    return;
  }

  setStatus(`Nie udalo sie uruchomic gry: ${result.message}`, 'error');
};

const launchGame = async (game: Game): Promise<void> => {
  setStatus(`Uruchamiam: ${game.name}`);
  const result = await window.gameLauncher.launchGame(game.id);
  handleLaunchResult(game.name, result);
};

const removeGame = async (game: Game): Promise<void> => {
  const result = await window.gameLauncher.removeGame(game.id);

  if (result.status === 'removed') {
    setStatus(`Usunieto z biblioteki: ${game.name}`, 'success');
    await loadGames();

    if (activeView === 'details') {
      exitDetails(games.length > 0 ? 'grid' : 'header');
      return;
    }

    if (games.length > 0) {
      applySelectionState(true);
    } else {
      focusAddButton();
    }
    return;
  }

  setStatus('Tego wpisu nie ma juz w bibliotece.', 'error');
  await loadGames();
};

const addGame = async (): Promise<void> => {
  if (addGameButton.disabled) {
    return;
  }

  addGameButton.disabled = true;
  setStatus('Czekam na wybor pliku uruchamiajacego...');

  try {
    const result = await window.gameLauncher.addGame();

    if (result.status === 'cancelled') {
      setStatus('Dodawanie gry anulowane.');
      return;
    }

    selectedGameId = result.game.id;

    if (result.status === 'existing') {
      setStatus(`Ta gra jest juz w bibliotece: ${result.game.name}`);
      await loadGames();
      applySelectionState(true);
      return;
    }

    setStatus(`Dodano gre: ${result.game.name}`, 'success');
    await loadGames();
    applySelectionState(true);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Nieznany blad.';
    setStatus(`Nie udalo sie dodac gry: ${message}`, 'error');
  } finally {
    addGameButton.disabled = false;
  }
};

const activateSelection = async (): Promise<void> => {
  if (activeView === 'details') {
    if (document.activeElement === detailsBackButton) {
      exitDetails('grid');
      return;
    }

    if (document.activeElement === detailsRemoveButton) {
      await removeSelectedGame();
      return;
    }

    const detailsGame = getDetailsGame();
    if (!detailsGame) {
      exitDetails('header');
      return;
    }

    await launchGame(detailsGame);
    return;
  }

  if (document.activeElement === addGameButton) {
    await addGame();
    return;
  }

  const selectedGame = getSelectedGame();
  if (!selectedGame) {
    focusAddButton();
    return;
  }

  enterDetails(selectedGame.id);
};

const removeSelectedGame = async (): Promise<void> => {
  const game = getActionGame();
  if (!game) {
    return;
  }

  await removeGame(game);
};

const moveDetailsSelection = (direction: Direction): void => {
  const focusableButtons = [
    detailsBackButton,
    detailsLaunchButton,
    detailsRemoveButton,
  ].filter((button) => !button.disabled);

  if (focusableButtons.length === 0) {
    return;
  }

  const currentIndex = focusableButtons.findIndex(
    (button) => button === document.activeElement,
  );

  if (currentIndex < 0) {
    focusDetailsLaunchButton();
    return;
  }

  const step = direction === 'left' || direction === 'up' ? -1 : 1;
  const nextIndex =
    (currentIndex + step + focusableButtons.length) % focusableButtons.length;

  focusableButtons[nextIndex].focus();
};

const moveLibrarySelection = (direction: Direction): void => {
  if (games.length === 0) {
    focusAddButton();
    return;
  }

  const activeElement = document.activeElement;

  if (activeElement === addGameButton) {
    if (direction === 'down') {
      setSelectedGameByIndex(0, true);
    }

    return;
  }

  const currentIndex = getSelectedGameIndex();
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const cardsPerRow = getCardsPerRow();
  const currentColumn = safeIndex % cardsPerRow;

  if (direction === 'left') {
    const targetIndex = safeIndex === 0 ? games.length - 1 : safeIndex - 1;
    setSelectedGameByIndex(targetIndex, true);
    return;
  }

  if (direction === 'right') {
    const targetIndex = safeIndex === games.length - 1 ? 0 : safeIndex + 1;
    setSelectedGameByIndex(targetIndex, true);
    return;
  }

  if (direction === 'up') {
    if (safeIndex < cardsPerRow) {
      focusAddButton();
      return;
    }

    setSelectedGameByIndex(safeIndex - cardsPerRow, true);
    return;
  }

  const downTarget = safeIndex + cardsPerRow;
  if (downTarget < games.length) {
    setSelectedGameByIndex(downTarget, true);
    return;
  }

  let wrappedIndex = currentColumn;
  if (wrappedIndex >= games.length) {
    wrappedIndex = games.length - 1;
  }

  setSelectedGameByIndex(wrappedIndex, true);
};

const moveSelection = (direction: Direction): void => {
  if (activeView === 'details') {
    moveDetailsSelection(direction);
    return;
  }

  moveLibrarySelection(direction);
};

const getPrimaryGamepad = (): Gamepad | null => {
  const gamepads = navigator.getGamepads?.() ?? [];
  for (const gamepad of gamepads) {
    if (gamepad?.connected) {
      return gamepad;
    }
  }

  return null;
};

const isButtonPressed = (gamepad: Gamepad, buttonIndex: number): boolean =>
  Boolean(gamepad.buttons[buttonIndex]?.pressed);

const detectGamepadDirection = (gamepad: Gamepad): Direction | null => {
  if (isButtonPressed(gamepad, GAMEPAD_DPAD_UP)) {
    return 'up';
  }

  if (isButtonPressed(gamepad, GAMEPAD_DPAD_DOWN)) {
    return 'down';
  }

  if (isButtonPressed(gamepad, GAMEPAD_DPAD_LEFT)) {
    return 'left';
  }

  if (isButtonPressed(gamepad, GAMEPAD_DPAD_RIGHT)) {
    return 'right';
  }

  const axisX = gamepad.axes[0] ?? 0;
  const axisY = gamepad.axes[1] ?? 0;
  const horizontalStrength = Math.abs(axisX);
  const verticalStrength = Math.abs(axisY);

  if (
    horizontalStrength < GAMEPAD_DEADZONE &&
    verticalStrength < GAMEPAD_DEADZONE
  ) {
    return null;
  }

  if (horizontalStrength >= verticalStrength) {
    return axisX < 0 ? 'left' : 'right';
  }

  return axisY < 0 ? 'up' : 'down';
};

const processGamepadDirection = (direction: Direction | null, now: number): void => {
  if (!direction) {
    heldDirection = null;
    return;
  }

  if (heldDirection !== direction) {
    heldDirection = direction;
    nextDirectionRepeatAt = now + GAMEPAD_FIRST_REPEAT_DELAY_MS;
    moveSelection(direction);
    return;
  }

  if (now >= nextDirectionRepeatAt) {
    nextDirectionRepeatAt = now + GAMEPAD_REPEAT_DELAY_MS;
    moveSelection(direction);
  }
};

const wasButtonJustPressed = (buttonIndex: number): boolean =>
  Boolean(gamepadButtonsSnapshot[buttonIndex]);

const pollGamepad = (now: number): void => {
  const gamepad = getPrimaryGamepad();

  if (!gamepad) {
    gamepadButtonsSnapshot = [];
    heldDirection = null;
    requestAnimationFrame(pollGamepad);
    return;
  }

  const direction = detectGamepadDirection(gamepad);
  processGamepadDirection(direction, now);

  const currentButtons = gamepad.buttons.map((button) => button.pressed);

  if (currentButtons[GAMEPAD_BUTTON_A] && !wasButtonJustPressed(GAMEPAD_BUTTON_A)) {
    void activateSelection();
  }

  if (currentButtons[GAMEPAD_BUTTON_B] && !wasButtonJustPressed(GAMEPAD_BUTTON_B)) {
    if (activeView === 'details') {
      exitDetails('grid');
    } else {
      focusAddButton();
    }
  }

  if (currentButtons[GAMEPAD_BUTTON_X] && !wasButtonJustPressed(GAMEPAD_BUTTON_X)) {
    void removeSelectedGame();
  }

  gamepadButtonsSnapshot = currentButtons;

  requestAnimationFrame(pollGamepad);
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
};

const onKeyDown = (event: KeyboardEvent): void => {
  if (isTypingTarget(event.target)) {
    return;
  }

  switch (event.key) {
    case 'ArrowUp':
      event.preventDefault();
      moveSelection('up');
      break;
    case 'ArrowDown':
      event.preventDefault();
      moveSelection('down');
      break;
    case 'ArrowLeft':
      event.preventDefault();
      moveSelection('left');
      break;
    case 'ArrowRight':
      event.preventDefault();
      moveSelection('right');
      break;
    case 'Enter':
      event.preventDefault();
      void activateSelection();
      break;
    case 'Escape':
      event.preventDefault();
      if (activeView === 'details') {
        exitDetails('grid');
      } else {
        focusAddButton();
      }
      break;
    case 'Delete':
      event.preventDefault();
      void removeSelectedGame();
      break;
    default:
      break;
  }
};

function createGameCard(game: Game): HTMLElement {
  const card = document.createElement('article');
  card.className = 'game-card';
  card.tabIndex = -1;
  card.dataset.gameId = game.id;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Pokaz szczegoly gry ${game.name}`);
  card.title = game.executablePath;

  const title = document.createElement('h2');
  title.textContent = game.name;

  const pathLabel = document.createElement('p');
  pathLabel.textContent = game.installDirectory;
  pathLabel.className = 'game-path';

  const metaLabel = getGameMetaLabel(game);
  if (metaLabel) {
    const metadataText = document.createElement('p');
    metadataText.className = 'game-meta';
    metadataText.textContent = metaLabel;
    card.append(title, metadataText, pathLabel);
  } else {
    card.append(title, pathLabel);
  }

  const coverImageUrl = game.rawg?.backgroundImageUrl;
  if (coverImageUrl) {
    card.classList.add('has-cover');
    card.style.backgroundImage = [
      'linear-gradient(180deg, rgba(12, 13, 15, 0.15) 10%, rgba(12, 13, 15, 0.88) 86%)',
      'linear-gradient(340deg, rgba(242, 184, 75, 0.28), transparent 52%)',
      `url("${getCssUrl(coverImageUrl)}")`,
    ].join(', ');
  }

  card.addEventListener('focus', () => {
    selectedGameId = game.id;
    applySelectionState(false);
  });

  card.addEventListener('mouseenter', () => {
    selectedGameId = game.id;
    applySelectionState(false);
  });

  card.addEventListener('click', () => {
    selectedGameId = game.id;
    applySelectionState(false);
    enterDetails(game.id);
  });

  return card;
}

addGameButton.addEventListener('click', () => {
  void addGame();
});

detailsBackButton.addEventListener('click', () => {
  exitDetails('grid');
});

detailsLaunchButton.addEventListener('click', () => {
  void activateSelection();
});

detailsRemoveButton.addEventListener('click', () => {
  void removeSelectedGame();
});

document.addEventListener('keydown', onKeyDown);

window.addEventListener('blur', () => {
  heldDirection = null;
  gamepadButtonsSnapshot = [];
});

window.addEventListener('gamepadconnected', () => {
  setStatus('Pad podlaczony.', 'success');
});

window.addEventListener('gamepaddisconnected', () => {
  heldDirection = null;
  gamepadButtonsSnapshot = [];
  setStatus('Pad odlaczony.');
});

requestAnimationFrame(pollGamepad);
setView('library');
focusAddButton();
void loadGames();
