'use client';

import { useSyncExternalStore } from 'react';

const capabilities = new WeakMap<Document, boolean>();
const subscribe = () => () => {};
const serverSnapshot = () => true;

function browserSnapshot(): boolean {
  if (typeof document === 'undefined') return true;
  const cached = capabilities.get(document);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    supported = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    supported = false;
  }
  capabilities.set(document, supported);
  return supported;
}

/** Stable browser capability snapshot, with a matching initial hydration value. */
export function useWebGLSupport(): boolean {
  return useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
}
