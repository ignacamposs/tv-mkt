import { MediaItem } from '../types/signage';

const CACHE_NAME = 'signage-media-cache-v1';

export class MediaCacheManager {
  private activeBlobUrls: Record<string, string> = {};

  async syncPlaylist(items: MediaItem[]): Promise<Record<string, string>> {
    if (typeof window === 'undefined' || !('caches' in window)) {
      return {};
    }

    const downloadableItems = items.filter(
      (item) =>
        (item.type === 'image' || item.type === 'video') &&
        !item.url.includes('youtube.com') &&
        !item.url.includes('youtu.be')
    );

    const cache = await window.caches.open(CACHE_NAME);
    const validUrls = new Set(downloadableItems.map((item) => item.url));
    const newBlobMap: Record<string, string> = {};

    const cachedRequests = await cache.keys();
    for (const request of cachedRequests) {
      if (!validUrls.has(request.url)) {
        await cache.delete(request);
      }
    }

    for (const item of downloadableItems) {
      try {
        let response = await cache.match(item.url);

        if (!response) {
          const networkResponse = await fetch(item.url, { mode: 'cors' });
          if (!networkResponse.ok) {
            throw new Error(`HTTP ${networkResponse.status}`);
          }
          await cache.put(item.url, networkResponse.clone());
          response = networkResponse;
        }

        if (response) {
          const blob = await response.blob();
          newBlobMap[item.url] = URL.createObjectURL(blob);
        }
      } catch (error) {
        console.warn(`[MediaCache] Error cacheando ${item.url}`, error);
        if (this.activeBlobUrls[item.url]) {
          newBlobMap[item.url] = this.activeBlobUrls[item.url];
        }
      }
    }

    Object.entries(this.activeBlobUrls).forEach(([originalUrl, oldBlobUrl]) => {
      if (newBlobMap[originalUrl] !== oldBlobUrl) {
        URL.revokeObjectURL(oldBlobUrl);
      }
    });

    this.activeBlobUrls = newBlobMap;
    return newBlobMap;
  }

  getCachedUrl(originalUrl: string): string {
    return this.activeBlobUrls[originalUrl] || originalUrl;
  }

  cleanup(): void {
    Object.values(this.activeBlobUrls).forEach((blobUrl) => {
      URL.revokeObjectURL(blobUrl);
    });
    this.activeBlobUrls = {};
  }
}

export const mediaCache = new MediaCacheManager();