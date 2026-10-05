/* A deliberately inert service worker, registered at /vr/ scope.
 *
 * Immich registers its own worker at scope "/", and that worker calls
 * respondWith for /api/assets/<id>/(original|thumbnail) — the exact URL this app
 * plays video from. It dedupes in-flight requests keyed by URL alone and hands
 * back a clone of the cached promise, which is wrong for a <video> element: the
 * element issues successive Range requests to the same URL, and the second one
 * gets a clone of the response to the first. The element sees a body that does
 * not match the range it asked for and gives up with MEDIA_ERR_SRC_NOT_SUPPORTED.
 *
 * A client is controlled by the worker with the longest matching scope, so
 * registering this one at /vr/ takes Immich's worker out of the path for these
 * pages. It defines no fetch handler at all, so every request goes straight to
 * the network as if no worker existed.
 */
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
