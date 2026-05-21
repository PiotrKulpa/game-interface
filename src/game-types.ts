export type RawgGameMetadata = {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly backgroundImageUrl: string | null;
  readonly backgroundAdditionalImageUrl?: string | null;
  readonly released: string | null;
  readonly rating: number | null;
  readonly description?: string | null;
};

export type GameLibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly executablePath: string;
  readonly installDirectory: string;
  readonly addedAt: string;
};

export type Game = GameLibraryEntry & {
  readonly rawg?: RawgGameMetadata;
};

export type AddGameResult =
  | { readonly status: 'added'; readonly game: Game }
  | { readonly status: 'existing'; readonly game: Game }
  | { readonly status: 'cancelled' };

export type LaunchGameResult =
  | { readonly status: 'launched' }
  | { readonly status: 'failed'; readonly message: string };

export type RemoveGameResult =
  | { readonly status: 'removed' }
  | { readonly status: 'missing' };

export type GameLauncherApi = {
  readonly listGames: () => Promise<readonly Game[]>;
  readonly addGame: () => Promise<AddGameResult>;
  readonly launchGame: (gameId: string) => Promise<LaunchGameResult>;
  readonly removeGame: (gameId: string) => Promise<RemoveGameResult>;
};
