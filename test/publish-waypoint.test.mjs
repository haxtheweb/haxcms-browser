// The rules the Publish dialog applies to what someone types for a Waypoint
// (src/site/publish-waypoint.js), before any window opens or request is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const waypoint = require("../src/site/publish-waypoint.js");

test("a Waypoint's address is https, or plain http only on this computer", () => {
  const clean = waypoint.cleanAddress;
  assert.equal(clean("waypoint.example.edu"), "https://waypoint.example.edu");
  assert.equal(
    clean(" https://waypoint.example.edu/some/page?x=1 "),
    "https://waypoint.example.edu",
  );
  assert.equal(clean("http://localhost:8080"), "http://localhost:8080");
  assert.equal(clean("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(
    clean("http://waypoint.localhost:8080"),
    "http://waypoint.localhost:8080",
  );
  for (const refused of [
    "",
    "http://waypoint.example.edu",
    "http://localhost.example.edu",
    "https://user:secret@waypoint.example.edu",
    "ftp://waypoint.example.edu",
    "javascript:alert(1)",
    "https://",
  ]) {
    assert.equal(clean(refused), null, refused);
  }
});

test("a site name is 3 to 40 characters and can be part of a web address", () => {
  const clean = waypoint.cleanName;
  assert.equal(clean("my-course"), "my-course");
  assert.equal(clean("  My-Course "), "my-course");
  assert.equal(clean("abc"), "abc");
  assert.equal(clean("a" + "b".repeat(39)), "a" + "b".repeat(39));
  for (const refused of [
    "",
    "ab",
    "1site",
    "-site",
    "site-",
    "my site",
    "my_site",
    "my.site",
    "a" + "b".repeat(40),
    "../etc",
  ]) {
    assert.equal(clean(refused), null, refused);
  }
});

test("a name is suggested from the site's own name", () => {
  const suggest = waypoint.suggestName;
  assert.equal(suggest("smoke-site"), "smoke-site");
  assert.equal(suggest("My Course 101"), "my-course-101");
  assert.equal(suggest("2026 Syllabus!"), "syllabus");
  assert.equal(suggest("a" + "b".repeat(60)).length, 40);
  assert.equal(suggest("---"), "my-site");
  assert.equal(suggest(""), "my-site");
  // whatever is suggested passes the Waypoint's own rule
  for (const name of [
    "x",
    "Über Kurs",
    "site-",
    "a-very-long-name-".repeat(5),
  ]) {
    assert.equal(waypoint.cleanName(suggest(name)), suggest(name), name);
  }
});
