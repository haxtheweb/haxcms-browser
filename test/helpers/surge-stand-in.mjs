// Send the broker's requests for outside services to local stand-ins.
// The broker only ever calls fixed https addresses; tests redirect them and
// leave every other request alone.

// { "https://surge.surge.sh": "http://127.0.0.1:1234", ... }
export function redirectHosts(map) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    for (const from of Object.keys(map)) {
      if (url === from || url.startsWith(from + "/")) {
        return realFetch(map[from] + url.slice(from.length), init);
      }
    }
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

export function redirectSurge(standIn) {
  return redirectHosts({ "https://surge.surge.sh": standIn });
}
