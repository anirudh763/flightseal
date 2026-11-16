// Keep persisted requiredPaths relative in the cache index, but normalize every
// path before comparing it with a FetchEvent URL pathname.
self.flightsealAssetPathSet = function flightsealAssetPathSet(requiredPaths, optionalPaths, scope) {
  return new Set([...requiredPaths, ...optionalPaths].map((path) => new URL(path, scope).pathname));
};
