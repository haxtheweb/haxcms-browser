// sharp for the browser runtime. The real sharp is a native library; this
// covers what haxcms-nodejs asks of it with the browser's own image decoder
// and an OffscreenCanvas, both available in a Worker:
//
//   sharp(pathOrBuffer).metadata()                  format, width, height
//   .rotate() .resize() .jpeg() .png() .webp()      then
//   .toFile(path) / .toBuffer()
//
// Rules this file keeps:
// - metadata() only reports a width and height for bytes the browser can
//   actually decode as an image (haxcms-nodejs uses that to refuse uploads
//   that are not the image their name claims). An SVG is not decoded here:
//   its size is read from its own width / height / viewBox.
// - Anything not implemented throws, by name. Nothing is silently skipped.
//
// Differences from real sharp, by design of the browser APIs: crops are
// centered (no entropy / attention strategies), metadata such as EXIF is
// dropped on re-encode, and output formats are JPEG, PNG and WebP.
const fs = require("fs");

function detectFormat(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpeg";
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  ) {
    return "png";
  }
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return "gif";
  }
  if (
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") {
    const brand = b.toString("latin1", 8, 12);
    if (brand === "avif" || brand === "avis") {
      return "avif";
    }
    if (brand.indexOf("hei") === 0 || brand === "mif1") {
      return "heif";
    }
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
    return "bmp";
  }
  const head = b.toString("utf8", 0, Math.min(b.length, 1024)).trimStart();
  if (
    /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
      head,
    )
  ) {
    return "svg";
  }
  return "";
}

const MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

function svgSize(bytes) {
  const text = bytes.toString("utf8", 0, Math.min(bytes.length, 8192));
  const tag = /<svg[^>]*>/i.exec(text);
  if (!tag) {
    return {};
  }
  const attribute = (name) => {
    const match = new RegExp(
      "\\s" + name + "\\s*=\\s*[\"']([^\"']+)[\"']",
      "i",
    ).exec(tag[0]);
    return match ? match[1] : "";
  };
  let width = parseFloat(attribute("width"));
  let height = parseFloat(attribute("height"));
  const box = attribute("viewBox")
    .split(/[\s,]+/)
    .map(Number);
  if (!(width > 0) && box.length === 4) {
    width = box[2];
  }
  if (!(height > 0) && box.length === 4) {
    height = box[3];
  }
  return width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : {};
}

function unsupported(name) {
  return () => {
    throw new Error(
      "sharp()." + name + " is not available in the browser runtime",
    );
  };
}

class Pipeline {
  constructor(input) {
    if (
      typeof input !== "string" &&
      !Buffer.isBuffer(input) &&
      !(input instanceof Uint8Array)
    ) {
      throw new Error(
        "sharp() in the browser runtime takes a file path or a Buffer",
      );
    }
    this.input = input;
    this.resizeTo = null;
    this.output = null; // { format, quality }
  }

  bytes() {
    return typeof this.input === "string"
      ? fs.readFileSync(this.input)
      : Buffer.from(this.input);
  }

  async decode(bytes, format) {
    if (!MIME[format]) {
      throw new Error("Input buffer contains unsupported image format");
    }
    if (typeof createImageBitmap !== "function") {
      throw new Error("this browser cannot decode images in a Worker");
    }
    // from-image applies the photo's EXIF orientation, which is what
    // sharp's rotate() with no angle does
    return createImageBitmap(new Blob([bytes], { type: MIME[format] }), {
      imageOrientation: "from-image",
    });
  }

  async metadata() {
    const bytes = this.bytes();
    const format = detectFormat(bytes);
    if (!format) {
      throw new Error("Input buffer contains unsupported image format");
    }
    if (format === "svg") {
      return Object.assign({ format, size: bytes.length }, svgSize(bytes));
    }
    const bitmap = await this.decode(bytes, format);
    const info = {
      format,
      size: bytes.length,
      width: bitmap.width,
      height: bitmap.height,
    };
    bitmap.close();
    return info;
  }

  rotate(angle) {
    if (angle !== undefined && angle !== null) {
      unsupported("rotate(angle)")();
    }
    return this; // EXIF orientation is applied on decode
  }

  resize(a, b, c) {
    let options = {};
    if (a && typeof a === "object") {
      options = a;
    } else {
      options = Object.assign({}, c || {}, { width: a, height: b });
    }
    const fit = options.fit || "cover";
    if (["cover", "contain", "fill", "inside", "outside"].indexOf(fit) === -1) {
      unsupported("resize({ fit: " + fit + " })")();
    }
    this.resizeTo = {
      width: options.width || null,
      height: options.height || null,
      fit,
      withoutEnlargement: !!options.withoutEnlargement,
    };
    return this;
  }

  jpeg(options) {
    const quality =
      options && typeof options.quality === "number" ? options.quality : 80;
    this.output = { format: "jpeg", quality: quality / 100 };
    return this;
  }

  png() {
    this.output = { format: "png" };
    return this;
  }

  webp(options) {
    const quality =
      options && typeof options.quality === "number" ? options.quality : 80;
    this.output = { format: "webp", quality: quality / 100 };
    return this;
  }

  // where the source lands on the output canvas for each fit
  layout(sourceWidth, sourceHeight) {
    const target = this.resizeTo;
    if (!target || (!target.width && !target.height)) {
      return {
        width: sourceWidth,
        height: sourceHeight,
        draw: [0, 0, sourceWidth, sourceHeight],
      };
    }
    const ratio = sourceWidth / sourceHeight;
    let width = target.width || Math.round(target.height * ratio);
    let height = target.height || Math.round(target.width / ratio);
    if (
      target.withoutEnlargement &&
      (width > sourceWidth || height > sourceHeight)
    ) {
      const shrink = Math.min(sourceWidth / width, sourceHeight / height);
      width = Math.round(width * shrink);
      height = Math.round(height * shrink);
    }
    if (target.fit === "fill") {
      return { width, height, draw: [0, 0, width, height] };
    }
    const cover = Math.max(width / sourceWidth, height / sourceHeight);
    const contain = Math.min(width / sourceWidth, height / sourceHeight);
    if (target.fit === "inside" || target.fit === "outside") {
      const scale = target.fit === "inside" ? contain : cover;
      const w = Math.round(sourceWidth * scale);
      const h = Math.round(sourceHeight * scale);
      return { width: w, height: h, draw: [0, 0, w, h] };
    }
    const scale = target.fit === "contain" ? contain : cover;
    const w = sourceWidth * scale;
    const h = sourceHeight * scale;
    return { width, height, draw: [(width - w) / 2, (height - h) / 2, w, h] };
  }

  async toBuffer() {
    const bytes = this.bytes();
    const format = detectFormat(bytes);
    if (!format || format === "svg") {
      throw new Error("Input buffer contains unsupported image format");
    }
    if (typeof OffscreenCanvas !== "function") {
      throw new Error("this browser cannot process images in a Worker");
    }
    const bitmap = await this.decode(bytes, format);
    const place = this.layout(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(place.width, place.height);
    const context = canvas.getContext("2d");
    context.drawImage(
      bitmap,
      place.draw[0],
      place.draw[1],
      place.draw[2],
      place.draw[3],
    );
    bitmap.close();
    // keep the input's format when none was asked for, where a canvas can
    const output = this.output || {
      format: format === "jpeg" || format === "webp" ? format : "png",
    };
    const blob = await canvas.convertToBlob({
      type: MIME[output.format],
      quality: output.quality,
    });
    return Buffer.from(await blob.arrayBuffer());
  }

  async toFile(file) {
    const data = await this.toBuffer();
    fs.writeFileSync(file, data);
    return { size: data.length };
  }
}

for (const name of [
  "avif",
  "blur",
  "composite",
  "extract",
  "extend",
  "flatten",
  "flip",
  "flop",
  "gif",
  "greyscale",
  "grayscale",
  "negate",
  "sharpen",
  "tiff",
  "trim",
  "withMetadata",
]) {
  Pipeline.prototype[name] = unsupported(name);
}

function sharp(input) {
  return new Pipeline(input);
}
sharp.fit = {
  cover: "cover",
  contain: "contain",
  fill: "fill",
  inside: "inside",
  outside: "outside",
};
// crops are centered here whichever of these is asked for
sharp.strategy = { entropy: "entropy", attention: "attention" };
sharp.cache = () => {};
sharp.concurrency = () => 1;
sharp.simd = () => false;

module.exports = sharp;
