// https for the browser runtime: outbound requests go through the browser's
// fetch (outbound.cjs, haxtheweb/issues#3389). There is no server.
const { client } = require("./outbound.cjs");

const { request, get } = client("https:");

function createServer() {
  throw new Error("https.createServer is not available in the browser runtime");
}

module.exports = {
  request,
  get,
  createServer,
  Agent: class Agent {},
  globalAgent: {},
};
