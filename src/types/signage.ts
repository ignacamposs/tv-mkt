export type MediaType = 'image' | 'video' | 'youtube';
export type ScreenCommand = 'playing' | 'paused' | 'blackout';
export type ScreenRotation = 0 | 90 | 180 | 270;
export type UserRole = 'agency' | 'client';

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  clientId?: string;
  name?: string;
}

export interface ClientAccount {
  id: string;
  name: string;
  email: string;
  ownerUid: string;
  active: boolean;
  createdAt?: unknown;
}

export interface MediaItem {
  id: string;
  title: string;
  type: MediaType;
  url: string;
  youtubeId?: string;
  duration: number;
  order: number;
  createdBy?: UserRole;
}

export interface Channel {
  id: string;
  name: string;
  items: MediaItem[];
  clientId?: string;
}

export interface ScreenTelemetry {
  lastSeen: number;
  isNetworkOnline: boolean;
  currentItemTitle: string;
  currentItemId?: string;
  cachedItemsCount: number;
  appVersion: string;
}

export interface CallerEntry {
  id: string;
  ticket: string;
  destination: string;
  timestamp: number;
}

export interface CallerState {
  current?: CallerEntry | null;
  history: CallerEntry[];
  prefix?: string;
  lastNumber?: number;
  defaultDestination?: string;
  voiceEnabled?: boolean;
  updatedAt?: number;
}

export interface Screen {
  id: string;
  name: string;
  pairingCode: string;
  deviceToken?: string;
  isPaired: boolean;
  channelId: string;
  clientId?: string;
  command: ScreenCommand;
  rotation: ScreenRotation;
  callerEnabled?: boolean;
  callerState?: CallerState;
  telemetry?: ScreenTelemetry;
  lastSeen?: unknown;
  status?: string;
  currentStatus?: string;
  cachedCount?: number;
}