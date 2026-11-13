// tty for the browser runtime: there is no terminal, so nothing is a TTY
// (color and progress output in haxcms-nodejs's dependencies turn off).
class ReadStream {}
class WriteStream {}
module.exports = { isatty: () => false, ReadStream, WriteStream };
