// Injected into the bundle: the globals Node code expects to exist.
import process from "./process.cjs";
import { Buffer } from "buffer";

export { process, Buffer };
