// Preload for test-eutils.mjs (node --import): replaces fetch inside the spawned server.
// MOCK_ESEARCH is returned with HTTP 200 for every esearch call; any other URL fails as offline.
const body = process.env.MOCK_ESEARCH;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/esearch.fcgi")) return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  throw new TypeError(`mock offline: ${new URL(u).host}`);
};
