// Storage utilities for persistence and quota estimation

export async function requestPersistentStorage() {
  if (!('storage' in navigator) || !navigator.storage.persist) {
    return { supported: false, persisted: false };
  }
  try {
    const persisted = await navigator.storage.persist();
    return { supported: true, persisted };
  } catch {
    return { supported: true, persisted: false };
  }
}

export async function estimateStorage() {
  if (!('storage' in navigator) || !navigator.storage.estimate) {
    return { supported: false, quota: null, usage: null, usageDetails: null };
  }
  try {
    const { quota, usage, usageDetails } = await navigator.storage.estimate();
    return { supported: true, quota, usage, usageDetails };
  } catch {
    return { supported: true, quota: null, usage: null, usageDetails: null };
  }
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}


