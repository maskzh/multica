const DEVICE_ID = 'MULTICA_DEVICE_ID';

// SHA-256 hash function (using Web Crypto API)
async function sha256(text: string): Promise<string> {
  const buffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Generate Device-Id header
export async function generateDeviceIdHeader(deviceId: string): Promise<string> {
  // First hash, take first 32 chars
  const hash1 = await sha256(deviceId);
  const hashedDeviceId = hash1.slice(0, 32);

  // Second hash, take first 8 chars
  const hash2 = await sha256(hashedDeviceId);
  const finalDeviceId = hash2.slice(0, 8) + hashedDeviceId;

  return finalDeviceId;
}

// Get or create Device ID
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return '';

  let deviceId = localStorage.getItem(DEVICE_ID);

  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID, deviceId);
  }

  return deviceId;
}
