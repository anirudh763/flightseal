export const SUITE_LINKS = Object.freeze([
  { name: 'FlightSeal', href: 'https://anirudh763.github.io/flightseal/console/', state: 'available' },
  { name: 'CueReport', href: 'https://anirudh763.github.io/talkback-triage-pilot/', state: 'unverified' },
  { name: 'Issue Warehouse', href: 'https://anirudh763.github.io/a11y-issue-warehouse/', state: 'unverified' },
  { name: 'Portfolio', href: 'https://anirudh763.github.io/portfolio/', state: 'unverified' },
]);

export function remoteRequestAcknowledged(response, body) {
  return !!(response?.ok && body && body.received === true);
}
