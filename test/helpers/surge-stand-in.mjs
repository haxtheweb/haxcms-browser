// Send the broker's requests for the Surge API to a local stand-in instead.
// The broker always calls https://surge.surge.sh (a fixed host); tests
// redirect that address and leave every other request alone.
export function redirectSurge(standIn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.startsWith("https://surge.surge.sh/")) {
      return realFetch(
        standIn + url.slice("https://surge.surge.sh".length),
        init,
      );
    }
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}
