/**
 * Extrae el ID de 11 caracteres de cualquier enlace de YouTube
 * (watch?v=, youtu.be/, shorts/, embed/)
 */
export function extractYouTubeId(url: string): string | null {
  const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regExp);
  return match ? match[1] : null;
}

/**
 * Genera un hash SHA-256 del PIN de seguridad para validarlo sin exponerlo en texto plano
 */
export async function hashSecurityPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}