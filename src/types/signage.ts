export type MediaType = 'image' | 'video' | 'youtube';

export interface MediaItem {
  id: string;
  type: MediaType;
  title: string;
  url: string;
  youtubeId?: string;
  duration: number; // Segundos en pantalla
  order: number;
}

export interface Channel {
  id: string;
  name: string;
  items: MediaItem[];
  updatedAt: number;
  lastAuthorizedBy?: string;
}

export type ScreenRotation = 0 | 90 | 180 | 270;
export type PlaybackCommand = 'playing' | 'paused' | 'blackout';

export interface ScreenTelemetry {
  lastSeen: number;
  isNetworkOnline: boolean;
  currentItemTitle: string;
  cachedItemsCount: number;
  appVersion: string;
}

export interface Screen {
  id: string;
  pairingCode: string;
  deviceToken: string;
  name: string;
  channelId: string | null;
  isPaired: boolean;
  rotation: ScreenRotation;
  command: PlaybackCommand;
  telemetry: ScreenTelemetry;
}