// net for the browser runtime: the address checks middleware uses (rate
// limiting keys requests by IP). There are no sockets; the rest throws.
const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv4(input) {
  return IPV4.test(String(input));
}

function isIPv6(input) {
  const value = String(input).split("%")[0];
  if (value.indexOf(":") === -1 || /[^0-9a-fA-F:.]/.test(value)) {
    return false;
  }
  const doubleColon = value.split("::").length - 1;
  if (doubleColon > 1) {
    return false;
  }
  let groups = value.split(":");
  const last = groups[groups.length - 1];
  let ipv4Tail = 0;
  if (last.indexOf(".") !== -1) {
    if (!isIPv4(last)) {
      return false;
    }
    groups = groups.slice(0, -1);
    ipv4Tail = 2;
  }
  const filled = groups.filter((g) => g !== "");
  if (!filled.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) {
    return false;
  }
  const count = filled.length + ipv4Tail;
  return doubleColon === 1 ? count < 8 : count === 8;
}

function isIP(input) {
  if (isIPv4(input)) {
    return 4;
  }
  if (isIPv6(input)) {
    return 6;
  }
  return 0;
}

function unavailable() {
  throw new Error("net sockets are not available in the browser runtime");
}

module.exports = {
  isIP,
  isIPv4,
  isIPv6,
  createServer: unavailable,
  createConnection: unavailable,
  connect: unavailable,
  Socket: class Socket {
    constructor() {
      unavailable();
    }
  },
};
