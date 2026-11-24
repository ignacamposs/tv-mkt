export type MediaType = 'image' | 'video' | 'youtube';
export type ScreenCommand = 'playing' | 'paused' | 'blackout';
export type ScreenRotation = 0 | 90 | 180 | 270;
export type UserRole = 'agency' | 'client';

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  clientId?: string; // Solo si role === 'client'
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
  createdBy?: UserRole; // 'agency' = bloqueado para el comercio | 'client' = editable por el comercio
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
  cachedItemsCount: number;
  appVersion: string;
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
  telemetry?: ScreenTelemetry;
  lastSeen?: unknown;
  status?: string;
  currentStatus?: string;
  cachedCount?: number;
}