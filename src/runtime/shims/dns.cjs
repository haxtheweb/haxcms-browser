// dns for the browser runtime (haxtheweb/issues#3389). A browser cannot
// resolve a name to an address; it does that itself when it connects. So:
// - an IP address is answered as itself, and haxcms-nodejs's own private /
//   reserved check decides whether it may be fetched;
// - a name that only means something on this device or a local network
//   (localhost, *.local, a single label, ...) is answered with the loopback
//   address, which that check refuses;
// - any other name gets a stand-in public address. Nothing connects to it:
//   the request shims (outbound.cjs) send requests to the name, and the
//   browser applies CORS (and, in Chromium, Private Network Access).
const net = require("net");
const { isLocalName, bareHost } = require("./outbound.cjs");

// A public address that is never connected to; see above.
const STAND_IN = "192.88.99.1";

function records(hostname) {
  const host = bareHost(hostname);
  const family = net.isIP(host);
  if (family) {
    return [{ address: host, family }];
  }
  if (isLocalName(host)) {
    return [{ address: "127.0.0.1", family: 4 }];
  }
  return [{ address: STAND_IN, family: 4 }];
}

async function lookupAsync(hostname, options) {
  const list = records(hostname);
  const opts = typeof options === "number" ? { family: options } : options;
  if (opts && opts.all) {
    return list;
  }
  return list[0];
}

function lookup(hostname, options, callback) {
  let cb = callback;
  let opts = options;
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  lookupAsync(hostname, opts).then(
    (result) => {
      if (opts && opts.all) {
        cb(null, result);
      } else {
        cb(null, result.address, result.family);
      }
    },
    (err) => cb(err),
  );
}

module.exports = {
  lookup,
  promises: { lookup: lookupAsync },
};
