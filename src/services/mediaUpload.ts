import { MediaType } from '../types/signage';

export interface UploadedMediaResult {
  url: string;
  type: Extract<MediaType, 'image' | 'video'>;
  suggestedTitle: string;
  detectedDuration: number;
}

function getVideoDurationInSeconds(file: File): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      window.URL.revokeObjectURL(video.src);
      const seconds = Math.ceil(video.duration);
      resolve(seconds > 1 ? seconds : 15);
    };

    video.onerror = () => {
      resolve(15);
    };

    video.src = URL.createObjectURL(file);
  });
}

function optimizeImageUrl(secureUrl: string): string {
  if (!secureUrl.includes('/upload/')) return secureUrl;
  return secureUrl.replace('/upload/', '/upload/f_auto,q_auto,w_1920,c_limit/');
}

export async function uploadMediaFile(file: File): Promise<UploadedMediaResult> {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error('Faltan configurar las variables de Cloudinary en .env.local');
  }

  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');

  if (!isVideo && !isImage) {
    throw new Error('Formato no soportado. Subí imágenes (JPG, PNG, WebP) o videos MP4.');
  }

  // Límite de 100 MB (máximo del plan gratuito de Cloudinary)
  const maxBytes = 100 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error('El archivo supera los 100 MB permitidos.');
  }

  const detectedDuration = isVideo ? await getVideoDurationInSeconds(file) : 10;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', uploadPreset);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    {
      method: 'POST',
      body: formData,
    }
  );

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData?.error?.message || 'Error al subir el archivo a Cloudinary');
  }

  const data = await response.json();
  const finalUrl = isImage ? optimizeImageUrl(data.secure_url) : data.secure_url;
  const cleanTitle = file.name.replace(/\.[^/.]+$/, '');

  return {
    url: finalUrl,
    type: isVideo ? 'video' : 'image',
    suggestedTitle: cleanTitle || 'Contenido subido',
    detectedDuration,
  };
}