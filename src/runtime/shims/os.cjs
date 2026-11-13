// os for the browser runtime. homedir is where haxcms-nodejs creates its
// default config (.haxcmsconfig) when no project _config is found.
module.exports = {
  EOL: "\n",
  constants: {},
  arch: () => "wasm",
  cpus: () => [],
  freemem: () => 0,
  homedir: () => "/home",
  hostname: () => "localhost",
  networkInterfaces: () => ({}),
  platform: () => "browser",
  release: () => "",
  tmpdir: () => "/tmp",
  totalmem: () => 0,
  type: () => "Browser",
  userInfo: () => ({ username: "user", homedir: "/home" }),
};
