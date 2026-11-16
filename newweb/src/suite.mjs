export const SUITE_LINKS = Object.freeze([
  { name: 'FlightSeal', href: 'https://anirudh763.github.io/flightseal/console/', state: 'available' },
  { name: 'Mavframe', href: 'https://anirudh763.github.io/mavframe/', state: 'available' },
  { name: 'CueReport', href: 'https://anirudh763.github.io/talkback-triage-pilot/', state: 'unverified' },
  { name: 'Issue Warehouse', href: 'https://anirudh763.github.io/a11y-issue-warehouse/', state: 'unverified' },
  { name: 'LeaseQ', href: 'https://anirudh763.github.io/leaseq/', state: 'unavailable' },
  { name: 'Portfolio', href: 'https://anirudh763.github.io/portfolio/', state: 'unverified' },
]);

export const MAVFRAME_HANDOFF = Object.freeze({
  href: 'https://anirudh763.github.io/mavframe/',
  accepts: ['.tlog', 'raw MAVLink v1/v2'],
  hashwingAccepts: ['.fseal', '.ulg', 'timestamp_us<TAB>payload TSV/TXT'],
});

export function remoteRequestAcknowledged(response, body) {
  return !!(response?.ok && body && body.received === true);
}
